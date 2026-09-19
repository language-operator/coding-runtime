import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateManifest, resolveManifest, satisfiesRange, interpolate, publicManifest } from '../src/manifest.mjs';

const base = {
  schemaVersion: 1,
  name: 'claude-code',
  serve: { surface: 'terminal', port: 8080 },
  terminal: { launch: ['launch-claude'], tmuxSession: 'claude', cwd: '${WORKDIR}' },
};

test('a well-formed manifest validates', () => {
  assert.deepEqual(validateManifest(base), []);
});

test('an unknown schemaVersion is refused rather than half-honoured', () => {
  const errors = validateManifest({ ...base, schemaVersion: 2 });
  assert.match(errors.join(' '), /unsupported schemaVersion 2/);
});

test('a terminal surface without a launch command is refused', () => {
  assert.match(
    validateManifest({ ...base, terminal: { tmuxSession: 'x' } }).join(' '),
    /terminal\.launch must be a non-empty array/,
    'the base has no default command; a missing one must fail loudly at build time',
  );
});

test('unknown surfaces and roles are rejected', () => {
  assert.match(validateManifest({ ...base, serve: { surface: 'proxy' } }).join(' '), /serve\.surface must be one of/);
  assert.match(validateManifest({ ...base, role: 'sidecar' }).join(' '), /role must be one of/);
});

test('paths resolve before the values that reference them', () => {
  const { manifest } = resolveManifest(
    { ...base, paths: { stateDir: '${WORKSPACE}/.cr' }, env: { CFG: '${STATE_DIR}/cfg', HOMEISH: '${HOME}' } },
    { env: {} },
  );
  assert.equal(manifest.paths.stateDir, '/workspace/.cr');
  assert.equal(manifest.env.CFG, '/workspace/.cr/cfg', '${STATE_DIR} must resolve after paths do');
  assert.equal(manifest.env.HOMEISH, '/workspace/.home');
});

test('WORKDIR follows the cloned repository when there is one', () => {
  assert.equal(resolveManifest(base, { env: {} }).manifest.terminal.cwd, '/workspace');
  assert.equal(
    resolveManifest(base, { env: { AGENT_REPO_DIR: '/workspace/app' } }).manifest.terminal.cwd,
    '/workspace/app',
  );
});

test('PORT from the environment wins over the manifest default', () => {
  // The operator never injects PORT, so the adapter chart must; when it does,
  // it has to actually take effect or `.Values.port` is decorative.
  assert.equal(resolveManifest(base, { env: { PORT: '9090' } }).manifest.serve.port, 9090);
  assert.equal(resolveManifest(base, { env: {} }).manifest.serve.port, 8080);
  assert.equal(resolveManifest({ ...base, serve: { surface: 'none' } }, { env: {} }).manifest.serve.port, 8080);
});

test('an unresolvable variable is left visible rather than blanked', () => {
  assert.equal(interpolate('${NOPE}/x', {}), '${NOPE}/x');
  assert.equal(interpolate('${A}-${B}', { A: 'a' }), 'a-${B}');
});

test('a base version outside the declared range warns but still starts', () => {
  const { warnings, manifest } = resolveManifest(
    { ...base, requires: { codingRuntime: '>=2.0.0' } },
    { env: {}, version: '1.4.0' },
  );
  assert.equal(warnings[0].code, 'BASE_VERSION_MISMATCH');
  assert.equal(manifest.name, 'claude-code', 'a version mismatch must not stop the agent from running');
});

test('semver ranges cover the comparators manifests actually use', () => {
  assert.ok(satisfiesRange('1.2.3', '>=1.0.0 <2.0.0'));
  assert.ok(!satisfiesRange('2.0.0', '>=1.0.0 <2.0.0'));
  assert.ok(!satisfiesRange('0.9.9', '>=1.0.0 <2.0.0'));
  assert.ok(satisfiesRange('1.0.0', '=1.0.0'));
  assert.ok(!satisfiesRange('not-a-version', '>=1.0.0'));
});

test('the served manifest hides paths and the command line by default', () => {
  const { manifest } = resolveManifest(base, { env: {} });
  const served = publicManifest(manifest);

  assert.equal(served.name, 'claude-code');
  assert.ok(!('terminal' in served), 'the launch command must not be public');
  assert.ok(!('paths' in served), 'internal paths must not be public');
  assert.ok(!('env' in served));

  const opted = publicManifest({ ...manifest, serve: { ...manifest.serve, exposeManifest: true } });
  assert.ok('terminal' in opted, 'opting in exposes the whole manifest');
});
