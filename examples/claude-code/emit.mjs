/**
 * claude-code emitter.
 *
 * Translates the normalized document into the two files Claude Code reads.
 * Both are merged rather than overwritten: they sit on the workspace PVC and
 * accumulate real user state — credentials from an interactive `/login`,
 * per-project history — that a re-seed on every pod restart must not discard.
 *
 * Note what is deliberately *not* set: ANTHROPIC_BASE_URL and
 * ANTHROPIC_AUTH_TOKEN. Claude Code authenticates against api.anthropic.com
 * directly, via `/login` or CLAUDE_CODE_OAUTH_TOKEN, rather than through the
 * cluster's LiteLLM gateway — so `config.gateway` goes unused here even though
 * every other runtime routes through it. That is a real open question about the
 * product, not an oversight; see the runtime's README.
 */

const CLAUDE_JSON_OWNS = [
  'mcpServers',
  ['projects', '/workspace', 'hasTrustDialogAccepted'],
  ['projects', '/workspace', 'hasCompletedProjectOnboarding'],
  'hasCompletedOnboarding',
  'oauthAccount',
];

export function emit(config, { env = {} } = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR ?? `${config.paths.workspace}/.claude`;

  // --- settings.json: model selection and the bell we rely on for the tab title
  const settings = {
    preferredNotifChannel: 'terminal_bell',
  };
  if (config.models.primary) settings.model = config.models.primary.id;

  // --- .claude.json: MCP servers, trust, onboarding
  // Entry form rather than an object, because the `projects` map is keyed by
  // absolute path and those keys cannot be spelled as dotted strings.
  const values = [];

  if (config.tools.length > 0) {
    values.push(['mcpServers', Object.fromEntries(
      config.tools.map((tool) => [tool.name, { type: 'http', url: tool.endpoint }]),
    )]);
  }

  // Pre-trust the workspace so Claude Code does not prompt on first run. The
  // trust check walks up the tree, so trusting /workspace covers the cloned
  // repository beneath it. Worth being clear about what that grants: anything
  // on the repository's tracked branch — .claude/settings.json hooks, CLAUDE.md
  // — then runs in this pod unprompted, so push access to an agent's repository
  // is equivalent to shell access in its pod.
  values.push([['projects', '/workspace', 'hasTrustDialogAccepted'], true]);
  values.push([['projects', '/workspace', 'hasCompletedProjectOnboarding'], true]);

  // With a token there is no `/login` flow, but the UI still treats the agent as
  // un-onboarded until an oauthAccount block exists. These placeholders are for
  // display only; the token is the actual credential.
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    const name = config.agent.name ?? 'agent';
    values.push(['hasCompletedOnboarding', true]);
    values.push(['oauthAccount', {
      accountUuid: '00000000-0000-0000-0000-000000000000',
      emailAddress: `${name}@language-operator.local`,
      organizationUuid: '00000000-0000-0000-0000-000000000000',
      displayName: name,
      organizationName: name,
      organizationRole: 'admin',
      workspaceRole: null,
    }]);
  }

  return [
    { path: `${configDir}/settings.json`, values: settings, owns: ['model', 'preferredNotifChannel'] },
    { path: `${configDir}/.claude.json`, values, owns: CLAUDE_JSON_OWNS },
  ];
}

export default emit;
