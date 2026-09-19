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

export function emit(config) {
  const configDir = config.paths.stateDir ? `${config.paths.stateDir}/opencode` : '/etc/opencode';
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

  if (config.tools.length > 0) {
    values.mcp = Object.fromEntries(
      config.tools.map((tool) => [tool.name, { type: 'remote', url: tool.endpoint }]),
    );
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
