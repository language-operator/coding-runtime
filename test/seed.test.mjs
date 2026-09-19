import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A silent logger that keeps what was said, so tests can assert on warnings. */
function recorder() {
  const lines = [];
  const push = (level) => (...args) => lines.push(`${level} ${args.join(' ')}`);
  return { log: push('log'), warn: push('warn'), error: push('error'), lines };
}

/**
 * Stand up a workspace that looks like the operator's: a writable PVC path, a
 * read-only agent config, and an adapter image's manifest and emitter.
 */
function stage({ adapter = 'claude-code', configYaml = null, manifestPatch = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cr-seed-'));
  const workspace = join(root, 'workspace');
  const agentConfig = join(root, 'agent-config.yaml');
  const manifestPath = join(root, 'runtime.json');

  writeFileSync(agentConfig, configYaml ?? '');

  const manifest = {
    schemaVersion: 1,
    name: adapter,
    role: 'main',
    env: adapter === 'claude-code' ? { CLAUDE_CONFIG_DIR: '${WORKSPACE}/.claude' } : {},
    paths: { agentConfigPath: agentConfig },
    config: { emitter: { type: 'module', path: join(REPO, 'examples', adapter, 'emit.mjs') } },
    serve: { surface: 'terminal', port: 8080 },
    terminal: { tmuxSession: adapter, launch: [`launch-${adapter}`], cwd: '${WORKDIR}' },
    ...manifestPatch,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    root,
    workspace,
    env: { CODING_RUNTIME_MANIFEST: manifestPath, WORKSPACE_DIR: workspace, AGENT_NAME: 'seed-test' },
  };
}

const FULL_CONFIG = `
agent:
  name: seed-test
  namespace: default
instructions: Review the pull request.
personas:
  - name: reviewer
    tone: direct
    expertise: Go and Kubernetes
tools:
  mem0:
    endpoint: http://mem0.tools.svc.cluster.local:8080/mcp
    protocol: mcp
models:
  sonnet:
    role: primary
    provider: anthropic
    model: claude-sonnet-4-5
    endpoint: http://gateway.default.svc.cluster.local:8000
`;

test('seed turns the operator config into the harness native files', async () => {
  const { workspace, env } = stage({ configYaml: FULL_CONFIG });
  const log = recorder();

  assert.equal(await main(['seed'], { env, log }), 0, log.lines.join('\n'));

  const settings = JSON.parse(readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'claude-sonnet-4-5');
  assert.equal(settings.preferredNotifChannel, 'terminal_bell');

  const claudeJson = JSON.parse(readFileSync(join(workspace, '.claude', '.claude.json'), 'utf8'));
  assert.deepEqual(claudeJson.mcpServers.mem0, { type: 'http', url: 'http://mem0.tools.svc.cluster.local:8080/mcp' });
  assert.equal(claudeJson.projects['/workspace'].hasTrustDialogAccepted, true);
});

test('seed preserves user state written by the harness itself', async () => {
  const { workspace, env } = stage({ configYaml: FULL_CONFIG });
  await main(['seed'], { env, log: recorder() });

  // Stand in for a `/login` having happened between restarts.
  const claudeJsonPath = join(workspace, '.claude', '.claude.json');
  const existing = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
  existing.oauthAccount = { emailAddress: 'real@example.com' };
  existing.userSettings = { theme: 'dark' };
  writeFileSync(claudeJsonPath, JSON.stringify(existing));

  await main(['seed'], { env, log: recorder() });

  const after = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
  assert.equal(after.userSettings.theme, 'dark', 'keys the runtime does not own must survive');
  assert.ok(after.mcpServers.mem0, 'managed keys are still refreshed');
});

test('removing the last tool removes its MCP server entry', async () => {
  const { workspace, env } = stage({ configYaml: FULL_CONFIG });
  await main(['seed'], { env, log: recorder() });
  const claudeJsonPath = join(workspace, '.claude', '.claude.json');
  assert.ok(JSON.parse(readFileSync(claudeJsonPath, 'utf8')).mcpServers.mem0);

  // The LanguageAgent dropped spec.tools; the operator rewrites config.yaml and
  // the Workflow restarts. The agent must stop advertising a tool that is gone.
  writeFileSync(join(dirname(env.CODING_RUNTIME_MANIFEST), 'agent-config.yaml'), `
agent: {name: seed-test, namespace: default}
models:
  sonnet: {role: primary, model: claude-sonnet-4-5, endpoint: 'http://gateway.default.svc.cluster.local:8000'}
`);
  await main(['seed'], { env, log: recorder() });

  const after = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
  assert.ok(!('mcpServers' in after), 'a removed tool must actually disappear');
});

test('seeding twice is byte-identical', async () => {
  const { workspace, env } = stage({ configYaml: FULL_CONFIG });
  await main(['seed'], { env, log: recorder() });
  const first = readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8');

  const log = recorder();
  await main(['seed'], { env, log });

  assert.equal(readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8'), first);
  assert.ok(log.lines.some((l) => l.includes('unchanged')), 'a no-op restart should report no change');
});

test('phantom config keys are reported on the way through', async () => {
  const { env } = stage({ configYaml: 'agent: {name: x}\na2a: {mode: server}\n' });
  const log = recorder();

  assert.equal(await main(['seed'], { env, log }), 0);
  assert.ok(
    log.lines.some((l) => l.includes('UNKNOWN_KEY') && l.includes('a2a')),
    `expected an UNKNOWN_KEY warning in:\n${log.lines.join('\n')}`,
  );
});

test('an empty agent config still produces a usable harness config', async () => {
  const { workspace, env } = stage({ configYaml: '' });
  assert.equal(await main(['seed'], { env, log: recorder() }), 0);

  const settings = JSON.parse(readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!('model' in settings), 'no models configured means no model key');
  assert.equal(settings.preferredNotifChannel, 'terminal_bell');
});

test('the debug snapshot is written but is not an input to anything', async () => {
  const { workspace, env } = stage({ configYaml: FULL_CONFIG });
  await main(['seed'], { env, log: recorder() });

  const snapshot = join(workspace, '.coding-runtime', 'config.json');
  assert.ok(existsSync(snapshot));
  assert.equal(JSON.parse(readFileSync(snapshot, 'utf8')).models.primary.id, 'claude-sonnet-4-5');
});

test('opencode seeds its own shape from the same inputs', async () => {
  const { workspace, env } = stage({ adapter: 'opencode', configYaml: FULL_CONFIG });
  assert.equal(await main(['seed'], { env, log: recorder() }), 0);

  const cfgPath = join(workspace, '.coding-runtime', 'opencode', 'opencode.jsonc');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(cfg.model, 'openai/claude-sonnet-4-5');
  assert.equal(cfg.autoupdate, false);
  assert.match(cfg.provider.openai.options.baseURL, /:8000\/v1$/);

  const instructions = readFileSync(join(workspace, '.coding-runtime', 'opencode', 'instructions.md'), 'utf8');
  assert.match(instructions, /Tone: direct\./);
  assert.match(instructions, /Review the pull request\./);
});

test('a missing manifest fails with an actionable message', async () => {
  const log = recorder();
  const code = await main(['seed'], { env: { CODING_RUNTIME_MANIFEST: '/nonexistent/runtime.json' }, log });

  assert.equal(code, 1);
  assert.match(log.lines.join('\n'), /no runtime manifest at/);
});

test('an invalid manifest names every problem at once', async () => {
  const { env } = stage({ manifestPatch: { schemaVersion: 99, name: '' } });
  const log = recorder();

  assert.equal(await main(['seed'], { env, log }), 1);
  const output = log.lines.join('\n');
  assert.match(output, /unsupported schemaVersion 99/);
  assert.match(output, /name is required/);
});
