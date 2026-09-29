/**
 * opencode emitter.
 *
 * opencode.jsonc is operator-managed in full — unlike Claude Code's files it
 * holds no user state — so every key here is owned and a dropped model or tool
 * disappears from the file on the next seed.
 *
 * Every model is registered under the single `openai` provider key regardless
 * of what the LanguageModel resources are named: the cluster gateway is
 * OpenAI-compatible and aggregates all of them behind one endpoint, so the
 * qualified id an agent selects is always `openai/<model id>`.
 */

/**
 * opencode's remote MCP default is 5000 ms to fetch a server's tools, too short
 * for an external server that may sit behind a control plane and wait on a
 * reconcile; header-bearing (external) entries get this instead.
 */
const EXTERNAL_TIMEOUT_MS = 30000;

export function emit(config, { renderHeaders = null } = {}) {
  const configDir = config.paths.stateDir ? `${config.paths.stateDir}/opencode` : '/etc/opencode';

  // An external server's headers go in as `{env:NAME}`, opencode's own
  // environment reference, so the token is never written into opencode.jsonc.
  // Rendering is all-or-nothing: a server whose headers cannot all be rendered
  // is left out (the helper warns), never configured without auth to 401
  // unexplained. `oauth: false` because opencode otherwise auto-detects OAuth
  // on a remote server and could send a headless agent into a browser flow it
  // cannot complete, even with a correct bearer header. A base runtime without
  // the helper cannot honour headers at all; failing the seed says so.
  const mcpServer = (tool) => {
    if (!tool.headers) return { type: 'remote', url: tool.endpoint };
    if (!renderHeaders) {
      throw new Error(`tool '${tool.name}' has headers, which need coding-runtime's ctx.renderHeaders; rebuild on a base that provides it`);
    }
    const headers = renderHeaders(tool.headers, {
      path: `tools.${tool.name}`,
      rewrite: (name) => `{env:${name}}`,
      clientSyntax: /\{(env|file):/,
    });
    return headers ? { type: 'remote', url: tool.endpoint, headers, oauth: false, timeout: EXTERNAL_TIMEOUT_MS } : null;
  };
  const writes = [];
  const values = { autoupdate: false };
  const owns = ['autoupdate', 'provider', 'model', 'mcp', 'instructions'];

  if (config.gateway) {
    values.provider = {
      openai: {
        options: { baseURL: config.gateway.openaiBaseUrl, apiKey: config.gateway.apiKey },
        models: Object.fromEntries(config.models.ordered.map((m) => [m.id, {}])),
      },
    };
  }

  if (config.models.primary) {
    values.model = `openai/${config.models.primary.id}`;
  }

  const mcpServers = config.tools.map((tool) => [tool.name, mcpServer(tool)]).filter(([, server]) => server);
  if (mcpServers.length > 0) {
    values.mcp = Object.fromEntries(mcpServers);
  }

  // Instructions and persona become standing context rather than a first
  // message, so the TUI opens with the agent already briefed — no timing
  // dependence on when the user first types.
  const standing = [config.systemPrompt, config.instructions].filter(Boolean).join('\n\n');
  if (standing) {
    const file = `${configDir}/instructions.md`;
    writes.push({ path: file, contents: `${standing}\n` });
    values.instructions = [file];
  }

  writes.push({ path: `${configDir}/opencode.jsonc`, values, owns });
  return writes;
}

export default emit;
