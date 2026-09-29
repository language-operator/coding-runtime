import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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

// An agent whose LanguageAgent selects no model: the harness picks its own, and
// the runtime must leave that choice alone.
const NO_MODELS_CONFIG = `
agent:
  name: seed-test
  namespace: default
instructions: Review the pull request.
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
  // The test staged a /login and then never checked it. Without this line the
  // suite stayed green while every restart deleted the account block and sent
  // the user back through onboarding with perfectly valid credentials on disk.
  assert.equal(
    after.oauthAccount?.emailAddress,
    'real@example.com',
    'an interactive /login must survive a re-seed',
  );
});

test('a model chosen with /model survives when the operator configures none', async () => {
  const { workspace, env } = stage({ configYaml: NO_MODELS_CONFIG });
  await main(['seed'], { env, log: recorder() });

  // Stand in for the user running /model between restarts.
  const settingsPath = join(workspace, '.claude', 'settings.json');
  const existing = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(existing.model, undefined, 'no operator model means the runtime sets none');
  writeFileSync(settingsPath, JSON.stringify({ ...existing, model: 'claude-opus-5' }));

  await main(['seed'], { env, log: recorder() });

  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(after.model, 'claude-opus-5', 'the runtime has no opinion, so it must not clear one');
  assert.equal(after.preferredNotifChannel, 'terminal_bell', 'owned keys are still reconciled');
});

test('an operator-configured model still wins over a stale value', async () => {
  const { workspace, env } = stage({ configYaml: FULL_CONFIG });
  await main(['seed'], { env, log: recorder() });

  const settingsPath = join(workspace, '.claude', 'settings.json');
  const seeded = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.ok(seeded.model, 'the operator configured a model, so one is set');

  writeFileSync(settingsPath, JSON.stringify({ ...seeded, model: 'something-else' }));
  await main(['seed'], { env, log: recorder() });

  assert.equal(
    JSON.parse(readFileSync(settingsPath, 'utf8')).model,
    seeded.model,
    'a key the operator does configure is still reconciled',
  );
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

/** Every file under a directory, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test('a per-agent gateway key reaches no file on the workspace volume', async () => {
  // The broad assertion on purpose: this covers config.json, owned.json,
  // opencode.jsonc and anything a later change adds, rather than the three
  // sinks known today.
  const SECRET = 'sk-langop-agent7.deadbeefcafe';
  const { workspace, env } = stage({
    adapter: 'opencode',
    configYaml: `
agent: {name: keytest, namespace: default}
models:
  m: {role: primary, model: claude-sonnet-4-5, endpoint: 'http://gateway.default.svc.cluster.local:8000'}
`,
  });

  assert.equal(await main(['seed'], { env: { ...env, MODEL_API_KEY: SECRET }, log: recorder() }), 0);

  const offenders = walk(workspace).filter((f) => readFileSync(f, 'utf8').includes(SECRET));
  assert.deepEqual(offenders, [], `the credential was written to ${offenders.join(', ')}`);

  // ...and the reference did land, so this is not passing by writing nothing.
  const cfg = JSON.parse(readFileSync(join(workspace, '.coding-runtime', 'opencode', 'opencode.jsonc'), 'utf8'));
  assert.equal(cfg.provider.openai.options.apiKey, '{env:MODEL_API_KEY}');
});

test('a server the operator withdrew before the upgrade is still cleared', async () => {
  // The upgrade boundary: a key already on disk, already withdrawn, at the
  // moment provenance is introduced. There is no record of writing it and none
  // can ever be made — so if the emitter merely omitted the key rather than
  // supplying it empty, the dead server would linger forever.
  const { workspace, env } = stage({
    configYaml: 'agent: {name: a, namespace: default}\n',
  });
  const claudeDir = join(workspace, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, '.claude.json'), JSON.stringify({
    mcpServers: { gone: { type: 'http', url: 'http://removed.example/mcp' } },
    oauthAccount: { emailAddress: 'real@example.com' },
  }));

  await main(['seed'], { env, log: recorder() });

  const after = JSON.parse(readFileSync(join(claudeDir, '.claude.json'), 'utf8'));
  assert.ok(!('mcpServers' in after), 'a withdrawn server must go even with no provenance record');
  assert.deepEqual(after.oauthAccount, { emailAddress: 'real@example.com' }, 'and user state must survive the same seed');
});
