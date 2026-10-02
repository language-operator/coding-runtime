/**
 * pi emitter.
 *
 * pi reads four operator-relevant files from its agent directory
 * ($PI_CODING_AGENT_DIR): models.json (providers), settings.json (defaults),
 * mcp.json (MCP servers) and AGENTS.md (global context). Unlike opencode's
 * single config, settings.json and mcp.json are also written by pi itself —
 * `/settings`, Ctrl+S in `/model`, exposure toggles in `/mcp` — so only the
 * keys below are owned and everything else in those files is the user's.
 *
 * The gateway is registered as its own provider, `langop`, rather than under
 * pi's built-in `openai`: a models.json entry for a built-in provider merges
 * into that provider's catalog, and the gateway's model list should stand on
 * its own. The cluster gateway is OpenAI-compatible and aggregates every
 * LanguageModel behind one endpoint, so the qualified id is always
 * `langop/<model id>`.
 *
 * models.json `providers` is owned in full, and is `{}` rather than absent
 * when there is no gateway: pi rejects a models.json without `providers`, and
 * owning only `providers.langop` would let the writer prune the file down to
 * `{}` when it is withdrawn. Credentials from `/login` live in auth.json and
 * `modelOverrides` is a separate key, so neither is touched.
 */

const PROVIDER = 'langop';

/**
 * pi's remote MCP default is 60 s per request. An external server may sit
 * behind a control plane and wait on a reconcile, but a minute is already
 * generous; header-bearing (external) entries get half that, so a wedged
 * server surfaces as an error rather than a hung turn.
 */
const EXTERNAL_TIMEOUT_S = 30;

/**
 * Text pi would interpolate. models.json takes `$NAME` and `${NAME}`, mcp.json
 * `${NAME}`; both treat a value that *starts* with `!` as a shell command to run
 * at request time. The base warns on the former and writes it anyway.
 */
const CLIENT_SYNTAX = /\$\{?[A-Za-z_]|^!/;
const rewrite = (name) => `\${${name}}`;

/**
 * A value pi would execute rather than send. The base renders `$(NAME)` into
 * `${NAME}`, which is safe, but a literal header or key that opens with `!` is
 * passed through with only a warning — and for pi that is not "a different
 * header than the spec asked for", it is a command run on every request.
 */
const executes = (value) => typeof value === 'string' && value.startsWith('!');

/**
 * The gateway credential, as pi should see it.
 *
 * When the operator issued a per-agent key, write pi's own environment
 * reference rather than the value: models.json lives on the workspace volume,
 * so resolving here would put the credential on disk for no gain. Without a
 * key, or on a base too old to render references, fall back to the shared
 * placeholder — the behaviour before per-agent keys existed.
 *
 * Note this falls back where `mcpServer` below throws. A header-bearing server
 * configured without its header fails unexplained, so refusing to seed is the
 * only honest signal; a missing gateway key costs attribution and nothing else,
 * and failing the boot over it would make an optional feature a hard dependency
 * on the base version.
 */
function gatewayKey(config, renderRef) {
  const fallback = config.gateway.apiKey;
  if (!config.gateway.apiKeyRef || !renderRef) return fallback;
  const key = renderRef(config.gateway.apiKeyRef, { path: 'gateway.apiKey', rewrite, clientSyntax: CLIENT_SYNTAX }) ?? fallback;
  return executes(key) ? fallback : key;
}

export function emit(config, { renderHeaders = null, renderRef = null } = {}) {
  const agentDir = config.paths.stateDir ? `${config.paths.stateDir}/pi` : `${config.paths.home}/.pi/agent`;

  // An external server's headers go in as `${NAME}`, pi's own environment
  // reference, so the token is never written into mcp.json. Rendering is
  // all-or-nothing: a server whose headers cannot all be rendered is left out
  // (the helper warns), never configured without auth to 401 unexplained. pi
  // only attempts OAuth on a server *without* an Authorization header, so a
  // header-bearing entry cannot send a headless agent into a browser flow. A
  // base runtime without the helper cannot honour headers at all; failing the
  // seed says so, as does a header pi would run as a command.
  const mcpServer = (tool) => {
    if (!tool.headers) return { url: tool.endpoint };
    if (!renderHeaders) {
      throw new Error(`tool '${tool.name}' has headers, which need coding-runtime's ctx.renderHeaders; rebuild on a base that provides it`);
    }
    const headers = renderHeaders(tool.headers, { path: `tools.${tool.name}`, rewrite, clientSyntax: CLIENT_SYNTAX });
    if (!headers) return null;
    const run = Object.keys(headers).filter((name) => executes(headers[name]));
    if (run.length > 0) {
      throw new Error(`tool '${tool.name}' header(s) ${run.join(', ')} start with '!', which pi runs as a shell command; quote or reword the value`);
    }
    return { url: tool.endpoint, headers, timeout: EXTERNAL_TIMEOUT_S };
  };

  // Every owned key below is supplied on every run, null included, so a
  // withdrawn model or tool is removed regardless of provenance.
  const models = { providers: {} };
  const settings = { defaultProvider: null, defaultModel: null, enableInstallTelemetry: false };
  const mcp = { mcpServers: null };

  if (config.gateway) {
    models.providers[PROVIDER] = {
      baseUrl: config.gateway.openaiBaseUrl,
      api: 'openai-completions',
      apiKey: gatewayKey(config, renderRef),
      models: config.models.ordered.map((m) => ({ id: m.id })),
    };
    if (config.models.primary) {
      settings.defaultProvider = PROVIDER;
      settings.defaultModel = config.models.primary.id;
    }
  }

  const mcpServers = config.tools.map((tool) => [tool.name, mcpServer(tool)]).filter(([, server]) => server);
  if (mcpServers.length > 0) {
    mcp.mcpServers = Object.fromEntries(mcpServers);
  }

  // Persona and instructions become global context rather than a first
  // message, so the TUI opens with the agent already briefed. AGENTS.md in the
  // agent directory loads for every working directory and needs no project
  // trust. It is written every run, empty when there is nothing to say: the
  // base never deletes a file an emitter stops mentioning, so omitting it would
  // leave withdrawn instructions in force.
  const standing = [config.systemPrompt, config.instructions].filter(Boolean).join('\n\n');

  return [
    { path: `${agentDir}/models.json`, values: models, owns: Object.keys(models) },
    { path: `${agentDir}/settings.json`, values: settings, owns: Object.keys(settings) },
    { path: `${agentDir}/mcp.json`, values: mcp, owns: Object.keys(mcp) },
    { path: `${agentDir}/AGENTS.md`, contents: standing ? `${standing}\n` : '' },
  ];
}

export default emit;
