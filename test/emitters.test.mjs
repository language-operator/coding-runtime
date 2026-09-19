import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize } from '../src/config/normalize.mjs';
import { caseNames, loadCase, GOLDEN_DIR, FIXED_INPUTS } from './helpers/corpus.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE = process.env.UPDATE_GOLDENS === '1';

// Every adapter runs against the same corpus. That is the point: a change to
// the normalizer shows up as a diff in each harness's emitted config at once,
// instead of surfacing one runtime at a time in production.
const ADAPTERS = ['claude-code', 'opencode'];

for (const adapter of ADAPTERS) {
  test(`${adapter} emits stable config for every fixture`, async (t) => {
    const { emit } = await import(join(REPO, 'examples', adapter, 'emit.mjs'));
    const outDir = join(GOLDEN_DIR, 'emitted', adapter);
    mkdirSync(outDir, { recursive: true });

    for (const name of caseNames()) {
      await t.test(name, () => {
        const { yamlText, env } = loadCase(name);
        const config = normalize({ yamlText, env, ...FIXED_INPUTS });
        const writes = emit(config, { env });
        const actual = `${JSON.stringify(writes, null, 2)}\n`;
        const goldenPath = join(outDir, `${name}.json`);

        if (UPDATE) {
          writeFileSync(goldenPath, actual);
          return;
        }
        assert.ok(existsSync(goldenPath), `no golden for ${adapter}/${name}; run UPDATE_GOLDENS=1 npm test`);
        assert.deepEqual(JSON.parse(actual), JSON.parse(readFileSync(goldenPath, 'utf8')));
      });
    }
  });
}

test('claude-code selects the model the operator marked primary', async () => {
  const { emit } = await import(join(REPO, 'examples', 'claude-code', 'emit.mjs'));
  const { yamlText, env } = loadCase('primary-not-first');
  const [settings] = emit(normalize({ yamlText, env, ...FIXED_INPUTS }), { env });

  // The shipping adapter takes the first mapping key here and would pick gpt-4o.
  assert.equal(settings.values.model, 'claude-sonnet-4-5');
});

test('claude-code leaves the Anthropic endpoint alone', async () => {
  const { emit } = await import(join(REPO, 'examples', 'claude-code', 'emit.mjs'));
  const { yamlText, env } = loadCase('spec-agents-example');
  const writes = emit(normalize({ yamlText, env, ...FIXED_INPUTS }), { env });

  // Claude Code talks to api.anthropic.com, not the cluster gateway. Asserted
  // so that if that ever changes it is a deliberate edit to this test.
  const serialized = JSON.stringify(writes);
  assert.ok(!serialized.includes('ANTHROPIC_BASE_URL'));
  assert.ok(!serialized.includes('sk-langop-proxy'));
});

/** Managed values may be an object or [path, value] entries; read either. */
const asMap = (values) => new Map(
  (Array.isArray(values) ? values : Object.entries(values)).map(([k, v]) => [Array.isArray(k) ? k.join('.') : k, v]),
);

test('claude-code only seeds the onboarding stub when a token is present', async () => {
  const { emit } = await import(join(REPO, 'examples', 'claude-code', 'emit.mjs'));
  const { yamlText } = loadCase('spec-agents-example');
  const config = normalize({ yamlText, env: {}, ...FIXED_INPUTS });

  const without = asMap(emit(config, { env: {} })[1].values);
  assert.ok(!without.has('oauthAccount'), 'an interactive /login agent must not be told it is onboarded');

  const withToken = asMap(emit(config, { env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } })[1].values);
  assert.equal(withToken.get('hasCompletedOnboarding'), true);
  assert.equal(withToken.get('oauthAccount').displayName, 'data-analyst');
});

test('claude-code pre-trusts the workspace, which is a real grant worth asserting', async () => {
  const { emit } = await import(join(REPO, 'examples', 'claude-code', 'emit.mjs'));
  const { yamlText, env } = loadCase('spec-agents-example');
  const values = asMap(emit(normalize({ yamlText, env, ...FIXED_INPUTS }), { env })[1].values);

  // Trusting /workspace means anything on the cloned repository's tracked
  // branch runs in the pod unprompted. Deliberate, but it should never change
  // silently.
  assert.equal(values.get('projects./workspace.hasTrustDialogAccepted'), true);
});

test('opencode registers every model behind the one gateway provider', async () => {
  const { emit } = await import(join(REPO, 'examples', 'opencode', 'emit.mjs'));
  const { yamlText, env } = loadCase('primary-not-first');
  const writes = emit(normalize({ yamlText, env, ...FIXED_INPUTS }), { env });
  const config = writes.at(-1).values;

  assert.equal(config.model, 'openai/claude-sonnet-4-5', 'the primary model is the default');
  assert.deepEqual(Object.keys(config.provider.openai.models).sort(), ['claude-sonnet-4-5', 'gpt-4o', 'gpt-4o-mini']);
  assert.match(config.provider.openai.options.baseURL, /:8000\/v1$/, 'opencode speaks the OpenAI shape');
  assert.equal(config.provider.openai.options.apiKey, 'sk-langop-proxy');
});

test('opencode turns persona and instructions into standing context', async () => {
  const { emit } = await import(join(REPO, 'examples', 'opencode', 'emit.mjs'));
  const { yamlText, env } = loadCase('spec-agents-example');
  const writes = emit(normalize({ yamlText, env, ...FIXED_INPUTS }), { env });

  const instructions = writes.find((w) => w.path.endsWith('instructions.md'));
  assert.ok(instructions, 'instructions must reach the harness somehow');
  assert.match(instructions.contents, /Tone: professional\./, 'the persona is the identity half');
  assert.match(instructions.contents, /analyst/, 'the instructions are the task half');
  assert.deepEqual(writes.at(-1).values.instructions, [instructions.path]);
});

test('every emitter declares ownership of everything it writes', async (t) => {
  // writeManagedJson throws on an undeclared key, so this catches the mistake
  // at test time rather than the first time a tool is removed in production.
  const { applyWrites } = await import('../src/emit.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  for (const adapter of ADAPTERS) {
    await t.test(adapter, async () => {
      const { emit } = await import(join(REPO, 'examples', adapter, 'emit.mjs'));
      const dir = mkdtempSync(join(tmpdir(), `cr-${adapter}-`));
      for (const name of caseNames()) {
        const { yamlText, env } = loadCase(name);
        const config = normalize({ yamlText, env, ...FIXED_INPUTS, paths: { workspace: dir } });
        // Rewrite absolute paths into the scratch dir so nothing escapes it.
        const writes = emit(config, { env }).map((wr) => ({ ...wr, path: join(dir, wr.path.replace(/^\//, '')) }));
        assert.doesNotThrow(() => applyWrites(writes), `${adapter}/${name} wrote an undeclared key`);
      }
    });
  }
});
