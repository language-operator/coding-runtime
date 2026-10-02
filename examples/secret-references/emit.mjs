/**
 * Behaviour: a credential reaches the harness as a *reference*, never as a value.
 *
 * The operator writes `$(NAME)` into config.yaml, standing for an environment
 * variable of the agent container, so the secret itself never enters the
 * ConfigMap. The normalized document keeps those references opaque, and the
 * emitter translates them into whatever reference syntax its harness reads. The
 * harness resolves them at connect time.
 *
 * The emitter must not resolve them itself. Every file written here lands on the
 * workspace volume, which outlives the pod and is readable by anything that
 * mounts it, so resolving at seed time would put the credential on disk for no
 * gain. `src/config/headers.mjs` is the one place the reference logic lives;
 * an emitter only names the target syntax.
 *
 * Four behaviours, all of them fail-closed:
 *
 *   - a reference the environment does not satisfy drops the whole server, with
 *     a HEADERS_UNRESOLVED warning;
 *   - a reference to a variable this harness refuses to expand does the same
 *     with HEADERS_RESERVED;
 *   - on a base too old to render references at all, a header-bearing server
 *     fails the seed rather than being configured without auth;
 *   - a value this harness would execute is never written.
 *
 * The pretend harness: references are `{{env:NAME}}`, a value beginning with
 * `!` is run as a shell command, and `HARNESS_API_KEY` is its own credential
 * variable, which it reads as empty inside MCP headers.
 */

const REFERENCE = (name) => `{{env:${name}}}`;
const CLIENT_SYNTAX = /\{\{env:/;
const RESERVED = ['HARNESS_API_KEY'];

/**
 * Refuse a value the harness would execute instead of reading.
 *
 * This harness runs any value beginning with `!` as a shell command, so an
 * operator-supplied string that starts with one is a command injection waiting
 * for the next seed. Nothing in the normalized document is validated against
 * *this* harness's quirks — it cannot be, since the quirk is the harness's —
 * which makes it the emitter's job.
 */
function refuseExecutable(value, where) {
  if (typeof value === 'string' && value.startsWith('!')) {
    throw new Error(`${where} begins with '!', which this harness runs as a shell command; refusing to seed`);
  }
  return value;
}

/**
 * The gateway credential, as the harness should see it.
 *
 * Falls back to the shared placeholder where `mcpServer` below throws, and the
 * asymmetry is deliberate. A header-bearing server configured without its
 * header fails later with an unexplained 401, so refusing to seed is the only
 * honest signal. A missing per-agent gateway key costs attribution and nothing
 * else, and failing the boot over it would turn an optional feature into a hard
 * dependency on the base version.
 */
function gatewayKey(config, renderRef) {
  if (!config.gateway.apiKeyRef || !renderRef) return config.gateway.apiKey;
  const rendered = renderRef(config.gateway.apiKeyRef, {
    path: 'gateway.apiKey',
    rewrite: REFERENCE,
    clientSyntax: CLIENT_SYNTAX,
    reserved: RESERVED,
  });
  // An executable value falls back rather than throwing, for the same reason
  // the rest of this function does.
  if (rendered?.startsWith('!')) return config.gateway.apiKey;
  return rendered ?? config.gateway.apiKey;
}

export function emit(config, { renderHeaders = null, renderRef = null } = {}) {
  const configDir = `${config.paths.stateDir}/secret-references`;

  const mcpServer = (tool) => {
    if (!tool.headers) return { url: tool.endpoint };

    // A base without the helper cannot honour headers at all. Saying so loudly
    // beats writing a server that will 401 with nothing pointing at the cause.
    if (!renderHeaders) {
      throw new Error(`tool '${tool.name}' has headers, which need coding-runtime's ctx.renderHeaders; rebuild on a base that provides it`);
    }

    // All-or-nothing: the helper returns null if *any* header is unrenderable,
    // and warns with the reason. A partially authenticated server is worse than
    // no server, because it looks configured.
    const headers = renderHeaders(tool.headers, {
      path: `tools.${tool.name}`,
      rewrite: REFERENCE,
      clientSyntax: CLIENT_SYNTAX,
      reserved: RESERVED,
    });
    if (!headers) return null;

    for (const [name, value] of Object.entries(headers)) {
      refuseExecutable(value, `header '${name}' of tool '${tool.name}'`);
    }
    return { url: tool.endpoint, headers };
  };

  const servers = config.tools.map((t) => [t.name, mcpServer(t)]).filter(([, s]) => s);

  const writes = [
    {
      path: `${configDir}/mcp.json`,
      owns: ['servers'],
      values: { servers: servers.length > 0 ? Object.fromEntries(servers) : null },
    },
  ];

  // `providers` is owned in full but must stay a mapping: this harness rejects a
  // models.json without one, so withdrawing the gateway leaves an empty map
  // rather than a null.
  const providers = config.gateway
    ? { gateway: { baseUrl: config.gateway.openaiBaseUrl, apiKey: gatewayKey(config, renderRef) } }
    : {};

  writes.push({
    path: `${configDir}/models.json`,
    owns: ['providers'],
    values: { providers },
  });

  return writes;
}

export default emit;
