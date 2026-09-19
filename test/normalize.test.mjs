import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { normalize, formatPersona } from '../src/config/normalize.mjs';
import { caseNames, loadCase, GOLDEN_DIR, FIXED_INPUTS } from './helpers/corpus.mjs';

const NORMALIZED_GOLDEN_DIR = join(GOLDEN_DIR, 'normalized');
// Regenerate with: UPDATE_GOLDENS=1 npm test
const UPDATE = process.env.UPDATE_GOLDENS === '1';

test('every fixture normalizes to its golden document', async (t) => {
  mkdirSync(NORMALIZED_GOLDEN_DIR, { recursive: true });

  for (const name of caseNames()) {
    await t.test(name, () => {
      const { yamlText, env } = loadCase(name);
      const actual = `${JSON.stringify(normalize({ yamlText, env, ...FIXED_INPUTS }), null, 2)}\n`;
      const goldenPath = join(NORMALIZED_GOLDEN_DIR, `${name}.json`);

      if (UPDATE) {
        writeFileSync(goldenPath, actual);
        return;
      }
      // Deliberately not auto-created: a golden written on first run records
      // whatever the code did that day, bug included, and then asserts it
      // forever. Adding a fixture is a two-step act.
      assert.ok(
        existsSync(goldenPath),
        `no golden for fixture '${name}'. Review the output, then run UPDATE_GOLDENS=1 npm test`,
      );
      // Compared as objects so a failure points at the field that moved rather
      // than printing two whole documents.
      assert.deepEqual(JSON.parse(actual), JSON.parse(readFileSync(goldenPath, 'utf8')));
    });
  }
});

test('normalizing is deterministic and free of hidden inputs', () => {
  for (const name of caseNames()) {
    const { yamlText, env } = loadCase(name);
    const once = normalize({ yamlText, env, ...FIXED_INPUTS });
    const twice = normalize({ yamlText, env, ...FIXED_INPUTS });
    assert.deepEqual(once, twice, `${name} normalized differently on a second call`);
  }
});

test('role: primary wins over mapping order, then priority, then declaration', () => {
  const { yamlText, env } = loadCase('primary-not-first');
  const { models } = normalize({ yamlText, env, ...FIXED_INPUTS });

  assert.equal(models.primary.key, 'omega', 'the model declared `role: primary` must win');
  assert.deepEqual(
    models.ordered.map((m) => m.key),
    ['omega', 'beta', 'alpha'],
    'primary first, then ascending priority',
  );
});

test('phantom fields warn without failing the seed', () => {
  const { yamlText, env } = loadCase('phantom-fields');
  const doc = normalize({ yamlText, env, ...FIXED_INPUTS });
  const unknown = doc.meta.warnings.filter((w) => w.code === 'UNKNOWN_KEY').map((w) => w.path);

  for (const path of ['a2a', 'peers', 'agent.displayName', 'personas[0].systemPrompt', 'personas[0].capabilities']) {
    assert.ok(unknown.includes(path), `expected an UNKNOWN_KEY warning for ${path}, got ${unknown.join(', ')}`);
  }
  // Still a usable config despite the noise.
  assert.equal(doc.agent.name, 'phantom');
  assert.equal(doc.instructions, 'Do the thing.');
  assert.equal(doc.tools.length, 1);
});

test('a persona renders byte-identically to the operator AGENT_PERSONA', () => {
  // formatPersona, languageagent_config.go:690-705 — trim each field, append a
  // period, join with newlines, skip empties entirely.
  assert.equal(
    formatPersona({ tone: ' professional ', personality: 'Analytical', expertise: 'Data' }),
    'Tone: professional.\nPersonality: Analytical.\nExpertise: Data.',
  );
  assert.equal(formatPersona({ tone: 'terse' }), 'Tone: terse.');
  assert.equal(formatPersona({ name: 'nameless-fields-only' }), '');
  assert.equal(formatPersona(null), '');
});

test('non-HTTP and endpointless tools are skipped with a warning, not dropped silently', () => {
  const { yamlText, env } = loadCase('sidecar-and-bad-tools');
  const doc = normalize({ yamlText, env, ...FIXED_INPUTS });

  assert.deepEqual(doc.tools.map((t) => t.name).sort(), ['service-tool', 'sidecar-tool']);
  assert.equal(doc.tools.find((t) => t.name === 'sidecar-tool').local, true, 'a localhost tool is a sidecar');
  assert.equal(doc.tools.find((t) => t.name === 'service-tool').local, false);

  const skipped = doc.meta.warnings.filter((w) => w.code === 'TOOL_SKIPPED').map((w) => w.path);
  assert.deepEqual(skipped.sort(), ['tools.endpointless-tool', 'tools.grpc-tool']);
});

test('with no config file at all, the environment alone yields a usable document', () => {
  const { yamlText, env } = loadCase('env-fallback');
  assert.equal(yamlText, null, 'this case must exercise the absent-file path');
  const doc = normalize({ yamlText, env, ...FIXED_INPUTS });

  assert.equal(doc.agent.name, 'env-agent');
  assert.equal(doc.instructions, 'Do what the env says.');
  assert.equal(doc.systemPrompt, 'Tone: terse.\nPersonality: Direct.');
  assert.equal(doc.models.primary.id, 'claude-sonnet-4-5');
  assert.equal(doc.models.ordered.length, 2);
  assert.equal(doc.gateway.source, 'env');
  assert.deepEqual(doc.tools.map((t) => t.name), ['mem0', 'localhost']);
  assert.ok(doc.meta.warnings.some((w) => w.code === 'CONFIG_ABSENT'));
});

test('an empty config degrades to nulls rather than throwing', () => {
  for (const yamlText of [null, '', '# just a comment\n', 'not-a-mapping', '[1,2,3]']) {
    const doc = normalize({ yamlText, env: {}, ...FIXED_INPUTS });
    assert.equal(doc.instructions, null);
    assert.equal(doc.persona, null);
    assert.equal(doc.models.primary, null);
    assert.deepEqual(doc.tools, []);
    assert.equal(doc.paths.workDir, '/workspace');
  }
});

test('the gateway exposes both client shapes so the emitter chooses', () => {
  const { yamlText, env } = loadCase('spec-agents-example');
  const { gateway } = normalize({ yamlText, env, ...FIXED_INPUTS });

  assert.equal(gateway.baseUrl, 'http://gateway.default.svc.cluster.local:8000');
  // OpenAI clients append /chat/completions; Anthropic clients append /v1/messages.
  assert.equal(gateway.openaiBaseUrl, 'http://gateway.default.svc.cluster.local:8000/v1');
  assert.equal(gateway.anthropicBaseUrl, 'http://gateway.default.svc.cluster.local:8000');
  assert.equal(gateway.apiKey, 'sk-langop-proxy');
});

test('AGENT_REPO_DIR becomes the working directory when a repository is cloned', () => {
  const { yamlText, env } = loadCase('spec-agents-example');
  const doc = normalize({ yamlText, env, ...FIXED_INPUTS });
  assert.equal(doc.paths.repoDir, '/workspace/analytics');
  assert.equal(doc.paths.workDir, '/workspace/analytics');

  const noRepo = normalize({ yamlText, env: {}, ...FIXED_INPUTS });
  assert.equal(noRepo.paths.repoDir, null);
  assert.equal(noRepo.paths.workDir, '/workspace');
});

test('caches are directed at the PVC, never at the memory-backed /tmp', () => {
  const { paths } = normalize({ yamlText: null, env: {}, ...FIXED_INPUTS });
  for (const key of ['tmpDir', 'cacheHome', 'dataHome', 'configHome', 'home', 'stateDir']) {
    assert.ok(
      paths[key].startsWith('/workspace/'),
      `${key} is ${paths[key]}; /tmp is a memory emptyDir with no sizeLimit, so filling it OOM-kills the pod`,
    );
  }
});
