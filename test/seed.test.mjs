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
 *
 * The emitter is one of `examples/`, each of which demonstrates a single
 * behaviour of the contract. These tests drive `seed` end to end — provenance,
 * idempotence, the credential rule — so they assert on what actually reaches the
 * volume rather than on a returned descriptor.
 */
function stage({ example = 'minimal', configYaml = null, manifestPatch = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cr-seed-'));
  const workspace = join(root, 'workspace');
  const agentConfig = join(root, 'agent-config.yaml');
  const manifestPath = join(root, 'runtime.json');

  writeFileSync(agentConfig, configYaml ?? '');

  const manifest = {
    schemaVersion: 1,
    name: example,
    role: 'main',
    paths: { agentConfigPath: agentConfig },
    config: { emitter: { type: 'module', path: join(REPO, 'examples', example, 'emit.mjs') } },
    serve: { surface: 'terminal', port: 8080 },
    terminal: { tmuxSession: example, launch: [`launch-${example}`], cwd: '${WORKDIR}' },
    ...manifestPatch,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    root,
    workspace,
    env: { CODING_RUNTIME_MANIFEST: manifestPath, WORKSPACE_DIR: workspace, AGENT_NAME: 'seed-test' },
  };
}

/** Where an example's managed file lands on the volume. */
const configFile = (workspace, example, name) => join(workspace, '.coding-runtime', example, name);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

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
  const { workspace, env } = stage({ example: 'owned-in-full', configYaml: FULL_CONFIG });
  const log = recorder();

  assert.equal(await main(['seed'], { env, log }), 0, log.lines.join('\n'));

  const config = readJson(configFile(workspace, 'owned-in-full', 'config.json'));
  assert.equal(config.model, 'claude-sonnet-4-5');
  assert.deepEqual(config.servers.mem0, { url: 'http://mem0.tools.svc.cluster.local:8080/mcp' });
  assert.equal(config.instructions, 'Review the pull request.');
});

test('seed preserves user state written by the harness itself', async () => {
  const { workspace, env } = stage({ example: 'opinion-withheld', configYaml: NO_MODELS_CONFIG });
  await main(['seed'], { env, log: recorder() });

  // Stand in for an interactive login having happened between restarts. `account`
  // is a key the runtime declares but withholds without a session token, and
  // `theme` is one it never claims at all.
  const statePath = configFile(workspace, 'opinion-withheld', 'state.json');
  const existing = readJson(statePath);
  existing.account = { emailAddress: 'real@example.com' };
  existing.theme = 'dark';
  writeFileSync(statePath, JSON.stringify(existing));

  await main(['seed'], { env, log: recorder() });

  const after = readJson(statePath);
  assert.equal(after.theme, 'dark', 'keys the runtime does not own must survive');
  assert.equal(after.managedBy, 'coding-runtime', 'owned keys are still reconciled');
  // Without this line the suite stayed green while every restart deleted the
  // account block and sent the user back through onboarding with perfectly valid
  // credentials on disk.
  assert.equal(
    after.account?.emailAddress,
    'real@example.com',
    'an interactive login must survive a re-seed',
  );
});

test('a model chosen in the harness survives when the operator configures none', async () => {
  const { workspace, env } = stage({ example: 'opinion-withheld', configYaml: NO_MODELS_CONFIG });
  await main(['seed'], { env, log: recorder() });

  const statePath = configFile(workspace, 'opinion-withheld', 'state.json');
  const existing = readJson(statePath);
  assert.equal(existing.model, undefined, 'no operator model means the runtime sets none');
  writeFileSync(statePath, JSON.stringify({ ...existing, model: 'claude-opus-5' }));

  await main(['seed'], { env, log: recorder() });

  const after = readJson(statePath);
  assert.equal(after.model, 'claude-opus-5', 'the runtime has no opinion, so it must not clear one');
  assert.equal(after.managedBy, 'coding-runtime', 'owned keys are still reconciled');
});

test('an operator-configured model still wins over a stale value', async () => {
  const { workspace, env } = stage({ example: 'opinion-withheld', configYaml: FULL_CONFIG });
  await main(['seed'], { env, log: recorder() });

  const statePath = configFile(workspace, 'opinion-withheld', 'state.json');
  const seeded = readJson(statePath);
  assert.ok(seeded.model, 'the operator configured a model, so one is set');

  writeFileSync(statePath, JSON.stringify({ ...seeded, model: 'something-else' }));
  await main(['seed'], { env, log: recorder() });

  assert.equal(
    readJson(statePath).model,
    seeded.model,
    'a key the operator does configure is still reconciled',
  );
});

test('removing the last tool removes its server entry', async () => {
  const { workspace, env } = stage({ example: 'owned-in-full', configYaml: FULL_CONFIG });
  await main(['seed'], { env, log: recorder() });
  const configPath = configFile(workspace, 'owned-in-full', 'config.json');
  assert.ok(readJson(configPath).servers.mem0);

  // The LanguageAgent dropped spec.tools; the operator rewrites config.yaml and
  // the Workflow restarts. The agent must stop advertising a tool that is gone.
  writeFileSync(join(dirname(env.CODING_RUNTIME_MANIFEST), 'agent-config.yaml'), `
agent: {name: seed-test, namespace: default}
models:
  sonnet: {role: primary, model: claude-sonnet-4-5, endpoint: 'http://gateway.default.svc.cluster.local:8000'}
`);
  await main(['seed'], { env, log: recorder() });

  const after = readJson(configPath);
  assert.ok(!('servers' in after), 'a removed tool must actually disappear');
});

test('seeding twice is byte-identical', async () => {
  const { workspace, env } = stage({ configYaml: FULL_CONFIG });
  await main(['seed'], { env, log: recorder() });
  const settingsPath = configFile(workspace, 'minimal', 'settings.json');
  const first = readFileSync(settingsPath, 'utf8');

  const log = recorder();
  await main(['seed'], { env, log });

  assert.equal(readFileSync(settingsPath, 'utf8'), first);
  assert.ok(log.lines.some((l) => l.includes('unchanged')), 'a no-op restart should report no change');
});

test('seeding an owned-file-only adapter twice reports the second as unchanged', async () => {
  // The regression from hermes-adapter#3, at the level it was reported. The
  // conformance check `seed is idempotent` greps a second seed for `unchanged`,
  // and `cli.mjs` only prints that for a write reporting changed: false. While
  // `writeOwnedFile` returned an unconditional true, managed JSON was the only
  // descriptor that could satisfy it, so an adapter whose harness config is YAML,
  // Markdown or `.env` could not pass at all.
  const { workspace, env } = stage({ example: 'owned-file', configYaml: FULL_CONFIG });

  const first = recorder();
  assert.equal(await main(['seed'], { env, log: first }), 0, first.lines.join('\n'));
  const agentsPath = configFile(workspace, 'owned-file', 'AGENTS.md');
  assert.match(readFileSync(agentsPath, 'utf8'), /Review the pull request\./);
  assert.ok(first.lines.some((l) => l.startsWith(`log wrote ${agentsPath}`)), 'the first seed writes it');

  const second = recorder();
  assert.equal(await main(['seed'], { env, log: second }), 0);
  assert.ok(
    second.lines.some((l) => l.startsWith(`log unchanged ${agentsPath}`)),
    `the second seed must report it unchanged, got:\n${second.lines.join('\n')}`,
  );

  // And a real edit is still written, so this is not passing by never writing.
  writeFileSync(join(dirname(env.CODING_RUNTIME_MANIFEST), 'agent-config.yaml'), `
agent: {name: seed-test, namespace: default}
instructions: Something else entirely.
`);
  const third = recorder();
  assert.equal(await main(['seed'], { env, log: third }), 0);
  assert.ok(third.lines.some((l) => l.startsWith(`log wrote ${agentsPath}`)), 'changed instructions are written');
  assert.match(readFileSync(agentsPath, 'utf8'), /Something else entirely\./);
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
  const { workspace, env } = stage({ example: 'opinion-withheld', configYaml: '' });
  assert.equal(await main(['seed'], { env, log: recorder() }), 0);

  const state = readJson(configFile(workspace, 'opinion-withheld', 'state.json'));
  assert.ok(!('model' in state), 'no models configured means no model key');
  assert.equal(state.managedBy, 'coding-runtime');
});

test('the debug snapshot is written but is not an input to anything', async () => {
  const { workspace, env } = stage({ configYaml: FULL_CONFIG });
  await main(['seed'], { env, log: recorder() });

  const snapshot = join(workspace, '.coding-runtime', 'config.json');
  assert.ok(existsSync(snapshot));
  assert.equal(readJson(snapshot).models.primary.id, 'claude-sonnet-4-5');
});

test('a second example seeds a different shape from the same inputs', async () => {
  // The same normalized document drives every emitter, so two examples reading it
  // must disagree only about output shape. That is the property that makes one
  // corpus enough for all of them.
  const { workspace, env } = stage({ example: 'secret-references', configYaml: FULL_CONFIG });
  assert.equal(await main(['seed'], { env, log: recorder() }), 0);

  const mcp = readJson(configFile(workspace, 'secret-references', 'mcp.json'));
  assert.deepEqual(mcp.servers.mem0, { url: 'http://mem0.tools.svc.cluster.local:8080/mcp' });

  const models = readJson(configFile(workspace, 'secret-references', 'models.json'));
  assert.match(models.providers.gateway.baseUrl, /:8000\/v1$/);
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
  // models.json and anything a later change adds, rather than the three sinks
  // known today.
  const SECRET = 'sk-langop-agent7.deadbeefcafe';
  const { workspace, env } = stage({
    example: 'secret-references',
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
  const models = readJson(configFile(workspace, 'secret-references', 'models.json'));
  assert.equal(models.providers.gateway.apiKey, '{{env:MODEL_API_KEY}}');
});

test('a server the operator withdrew before the upgrade is still cleared', async () => {
  // The upgrade boundary: a key already on disk, already withdrawn, at the
  // moment provenance is introduced. There is no record of writing it and none
  // can ever be made — so if the emitter merely omitted the key rather than
  // supplying it empty, the dead server would linger forever. This is why
  // `examples/owned-in-full/` supplies every owned key on every run.
  const { workspace, env } = stage({
    example: 'owned-in-full',
    configYaml: 'agent: {name: a, namespace: default}\n',
  });
  const configDir = join(workspace, '.coding-runtime', 'owned-in-full');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    servers: { gone: { url: 'http://removed.example/mcp' } },
    theme: 'dark',
  }));

  await main(['seed'], { env, log: recorder() });

  const after = readJson(join(configDir, 'config.json'));
  assert.ok(!('servers' in after), 'a withdrawn server must go even with no provenance record');
  assert.equal(after.theme, 'dark', 'and user state must survive the same seed');
});
