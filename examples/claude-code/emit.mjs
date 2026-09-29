/**
 * claude-code emitter.
 *
 * Translates the normalized document into the two files Claude Code reads.
 * Both are merged rather than overwritten: they sit on the workspace PVC and
 * accumulate real user state — the account block an interactive `/login`
 * writes, a model chosen with `/model`, per-project history — that a re-seed
 * on every pod restart must not discard.
 *
 * Merging alone does not achieve that, which is the trap this emitter fell into
 * once already: `owns` means "reconcile this key every boot", and a key listed
 * there but absent from `values` is *deleted*. So a key may be owned only when
 * its absence genuinely means "remove it" — dropping the last tool has to
 * remove the MCP server entry — and a key the runtime supplies only sometimes
 * must be owned only when it is actually supplied. Claiming one unconditionally
 * deletes whatever the user established, on every single restart.
 *
 * Note what is deliberately *not* set: ANTHROPIC_BASE_URL and
 * ANTHROPIC_AUTH_TOKEN. Claude Code authenticates against api.anthropic.com
 * directly, via `/login` or CLAUDE_CODE_OAUTH_TOKEN, rather than through the
 * cluster's LiteLLM gateway — so `config.gateway` goes unused here even though
 * every other runtime routes through it. That is a real open question about the
 * product, not an oversight; see the runtime's README.
 */

// Keys reconciled on every seed, because for these an absence really does mean
// "remove it": the operator dropping its last tool must take the MCP server
// entry with it. The trust markers are always supplied, so owning them costs
// nothing and keeps them honest if that ever changes.
//
// hasCompletedOnboarding and oauthAccount are deliberately NOT here. They are
// supplied only in CLAUDE_CODE_OAUTH_TOKEN mode, and are owned only in that
// same branch — see emit(). Under an interactive `/login` the runtime has no
// opinion about them, and having no opinion has to mean leaving them alone.
const CLAUDE_JSON_OWNS = [
  'mcpServers',
  ['projects', '/workspace', 'hasTrustDialogAccepted'],
  ['projects', '/workspace', 'hasCompletedProjectOnboarding'],
];

// Variables Claude Code reads as empty inside a remote MCP server's `headers`,
// so its own credentials cannot be leaked to a third-party server. A reference
// to one silently sends an empty token and the server 401s, so the emitter
// refuses it up front (HEADERS_RESERVED) and asks for the credential under
// another name. Best-effort mirror of Claude Code's list; extend as needed.
const CLAUDE_RESERVED_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

export function emit(config, { env = {}, renderHeaders = null } = {}) {
  const configDir = env.CLAUDE_CONFIG_DIR ?? `${config.paths.workspace}/.claude`;

  // An external server's headers go in as `${NAME}`, which Claude Code expands
  // from the environment when it connects, so the token is never written into
  // .claude.json. Rendering is all-or-nothing: a server whose headers cannot
  // all be rendered is left out (the helper warns), never configured without
  // auth to 401 unexplained. A base runtime without the helper cannot honour
  // headers at all, and failing the seed is the only way to say so.
  const mcpServer = (tool) => {
    if (!tool.headers) return { type: 'http', url: tool.endpoint };
    if (!renderHeaders) {
      throw new Error(`tool '${tool.name}' has headers, which need coding-runtime's ctx.renderHeaders; rebuild on a base that provides it`);
    }
    const headers = renderHeaders(tool.headers, {
      path: `tools.${tool.name}`,
      rewrite: (name) => `\${${name}}`,
      clientSyntax: /\$\{/,
      reserved: CLAUDE_RESERVED_VARIABLES,
    });
    return headers ? { type: 'http', url: tool.endpoint, headers } : null;
  };

  // --- settings.json: model selection and the bell we rely on for the tab title
  const settings = {
    preferredNotifChannel: 'terminal_bell',
  };
  // Owned only when the operator selects a model. With none configured the
  // runtime has no opinion, and `model` is then whatever the user picked with
  // `/model` — owning it unconditionally would delete that choice on the next
  // restart. The cost is that a model the operator stops configuring lingers
  // rather than being cleared, which `/model` can undo; the reverse mistake
  // silently discards a user's setting and looks like a bug in Claude Code.
  const settingsOwns = ['preferredNotifChannel'];
  if (config.models.primary) {
    settings.model = config.models.primary.id;
    settingsOwns.push('model');
  }

  // --- .claude.json: MCP servers, trust, onboarding
  // Entry form rather than an object, because the `projects` map is keyed by
  // absolute path and those keys cannot be spelled as dotted strings.
  const values = [];
  const owns = [...CLAUDE_JSON_OWNS];

  const mcpServers = config.tools.map((tool) => [tool.name, mcpServer(tool)]).filter(([, server]) => server);
  if (mcpServers.length > 0) {
    values.push(['mcpServers', Object.fromEntries(mcpServers)]);
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
    owns.push('hasCompletedOnboarding', 'oauthAccount');
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
    { path: `${configDir}/settings.json`, values: settings, owns: settingsOwns },
    { path: `${configDir}/.claude.json`, values, owns },
  ];
}

export default emit;
