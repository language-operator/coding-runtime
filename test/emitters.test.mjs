import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize } from '../src/config/normalize.mjs';
import { emitterContext } from '../src/emit.mjs';
import { caseNames, loadCase, GOLDEN_DIR, FIXED_INPUTS } from './helpers/corpus.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE = process.env.UPDATE_GOLDENS === '1';

// Each example demonstrates one behaviour of the emitter contract, and every one
// runs against the same corpus. That is the point: a change to the normalizer
// shows up as a diff in each behaviour at once, instead of surfacing one at a
// time in production.
//
// These are examples, not copies of adapters. An adapter's own output shape is
// its business and is tested in its own repository, against the base digest it
// pins — the one arrangement without a dependency cycle. What is tested here is
// only what this runtime promises.
const EXAMPLES = ['minimal', 'opinion-withheld', 'owned-file', 'owned-in-full', 'secret-references'];

const emitterFor = (example) => import(join(REPO, 'examples', example, 'emit.mjs'));

/** Normalize a corpus case and emit it, with warnings collected. */
async function emitCase(example, name, { env: envOverride, ctx } = {}) {
  const { emit } = await emitterFor(example);
  const { yamlText, env: caseEnv } = loadCase(name);
  const env = envOverride ?? caseEnv;
  const warnings = [];
  const config = normalize({ yamlText, env, ...FIXED_INPUTS });
  const writes = emit(config, ctx ?? emitterContext({ env, onWarn: (w) => warnings.push(w) }));
  return { writes, warnings, config, env };
}

const fileNamed = (writes, name) => writes.find((w) => w.path.endsWith(`/${name}`));

for (const example of EXAMPLES) {
  test(`${example} emits stable config for every fixture`, async (t) => {
    const { emit } = await emitterFor(example);
    const outDir = join(GOLDEN_DIR, 'emitted', example);
    mkdirSync(outDir, { recursive: true });

    for (const name of caseNames()) {
      await t.test(name, () => {
        const { yamlText, env } = loadCase(name);
        const config = normalize({ yamlText, env, ...FIXED_INPUTS });
        const writes = emit(config, emitterContext({ env }));
        const actual = `${JSON.stringify(writes, null, 2)}\n`;
        const goldenPath = join(outDir, `${name}.json`);

        if (UPDATE) {
          writeFileSync(goldenPath, actual);
          return;
        }
        assert.ok(existsSync(goldenPath), `no golden for ${example}/${name}; run UPDATE_GOLDENS=1 npm test`);
        assert.deepEqual(JSON.parse(actual), JSON.parse(readFileSync(goldenPath, 'utf8')));
      });
    }
  });
}

test('every example declares ownership of everything it writes', async (t) => {
  // writeManagedJson throws on an undeclared key, so this catches the mistake at
  // test time rather than the first time a key needs removing in production.
  const { applyWrites } = await import('../src/emit.mjs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  for (const example of EXAMPLES) {
    await t.test(example, async () => {
      const { emit } = await emitterFor(example);
      const dir = mkdtempSync(join(tmpdir(), `cr-${example}-`));
      for (const name of caseNames()) {
        const { yamlText, env } = loadCase(name);
        const config = normalize({ yamlText, env, ...FIXED_INPUTS, paths: { workspace: dir } });
        // Rewrite absolute paths into the scratch dir so nothing escapes it.
        const writes = emit(config, emitterContext({ env })).map((wr) => ({ ...wr, path: join(dir, wr.path.replace(/^\//, '')) }));
        assert.doesNotThrow(() => applyWrites(writes), `${example}/${name} wrote an undeclared key`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// A key owned in full is supplied every run, null included
// ---------------------------------------------------------------------------

test('owned-in-full answers every declared key on every run', async () => {
  // The guarantee is about shape, not content, so it must hold for a config that
  // sets nothing as much as for one that sets everything. A key in `owns` that
  // goes unanswered is the bug this asserts against.
  for (const name of ['minimal', 'spec-agents-example']) {
    const { writes } = await emitCase('owned-in-full', name);
    const [{ values, owns }] = writes;
    assert.deepEqual(Object.keys(values).sort(), [...owns].sort(), `${name} left an owned key unanswered`);
  }
});

test('owned-in-full states "nothing configured" as null rather than by omission', async () => {
  // null removes the key whoever last wrote it. Omitting it instead would fall
  // through to provenance, and a key with no provenance record is never deleted —
  // so a withdrawn tool would outlive the withdrawal rather than survive one boot.
  const { writes } = await emitCase('owned-in-full', 'minimal');
  const [{ values }] = writes;
  assert.deepEqual(values, { model: null, models: null, servers: null, instructions: null });
});

// ---------------------------------------------------------------------------
// A key the runtime only sometimes has an opinion about is omitted
// ---------------------------------------------------------------------------

test('opinion-withheld omits what it has no opinion about, so provenance protects the user', async () => {
  const { writes } = await emitCase('opinion-withheld', 'minimal');
  const [{ values, owns }] = writes;

  // `minimal` configures no model. The user may have chosen one in the harness,
  // and that choice is not the runtime's to discard — so the key is absent, not
  // null. This is the distinction that once deleted login state on every boot.
  assert.ok(owns.includes('model'), 'the key is still declared; declaring is not promising');
  assert.ok(!('model' in values), 'an unsupplied key must be absent, never null');
  // The positive control: something was written, so the absence above is a
  // decision rather than an empty file.
  assert.equal(values.managedBy, 'coding-runtime');
});

test('opinion-withheld asserts authority only when it actually has it', async () => {
  // Without a token the agent logs in interactively. Telling it onboarding is
  // complete would skip the flow that obtains its credentials.
  const { writes: without } = await emitCase('opinion-withheld', 'spec-agents-example', { env: {} });
  const [{ values: interactive }] = without;
  assert.ok(!('onboardingCompleted' in interactive), 'an interactive-login agent must not be told it is onboarded');
  assert.ok(!('account' in interactive));

  const { writes: withToken } = await emitCase('opinion-withheld', 'spec-agents-example', {
    env: { AGENT_SESSION_TOKEN: 'tok' },
  });
  const [{ values: provisioned }] = withToken;
  assert.equal(provisioned.onboardingCompleted, true);
  assert.equal(provisioned.account.displayName, 'data-analyst');
});

// ---------------------------------------------------------------------------
// A file the runtime owns outright is replaced, not merged
// ---------------------------------------------------------------------------

test('owned-file writes whole contents and claims no keys', async () => {
  const { writes } = await emitCase('owned-file', 'spec-agents-example');
  const [agents] = writes;

  // No `owns` list, because there is nothing to negotiate: the runtime's content
  // is the whole file. This is also the only honest descriptor for a harness whose
  // config is not JSON — merging into parsed JSON would quarantine a YAML file the
  // moment the harness rewrote it in its own format.
  assert.equal(agents.owns, undefined);
  assert.equal(agents.values, undefined);
  assert.match(agents.contents, /data analyst/);
});

test('owned-file states a withdrawal rather than leaving it in force', async () => {
  // The operator supplying no instructions must clear the file, not skip it.
  // Skipping would leave the previous run's standing context governing an agent
  // that is no longer meant to have it.
  const { writes } = await emitCase('owned-file', 'minimal');
  assert.equal(writes[0].contents, '');
});

// ---------------------------------------------------------------------------
// Credentials reach the harness as references, never values
// ---------------------------------------------------------------------------

test('secret-references writes an environment reference, never the token', async () => {
  const { writes, warnings, env } = await emitCase('secret-references', 'external-headers');
  const serialized = JSON.stringify(writes);

  assert.ok(!serialized.includes(env.CONTROL_PLANE_TOKEN), 'the token must never be written to disk');
  assert.ok(!serialized.includes('$(CONTROL_PLANE_TOKEN)'), 'the operator syntax must be translated');

  const { servers } = fileNamed(writes, 'mcp.json').values;
  assert.deepEqual(servers['control-plane'].headers, {
    Authorization: 'Bearer {{env:CONTROL_PLANE_TOKEN}}',
    'X-Agent': 'external',
  });

  // An in-cluster tool needs no credential, so it gains no headers key at all.
  assert.equal(servers['in-cluster'].headers, undefined);

  // `partial` references MISSING_TOKEN, which the fixture leaves unset. Rendering
  // is all-or-nothing, so the server is left out entirely rather than configured
  // without auth to 401 with nothing pointing at the cause.
  assert.equal(servers.partial, undefined, 'a server with an unrenderable header is not configured at all');
  assert.deepEqual(warnings.map((w) => [w.code, w.path]), [['HEADERS_UNRESOLVED', 'tools.partial.headers']]);
});

test('secret-references refuses a header referencing a variable the harness will not expand', async () => {
  const { emit } = await emitterFor('secret-references');
  const yamlText = 'tools:\n  ext: {endpoint: https://x.example/mcp, headers: {Authorization: Bearer $(HARNESS_API_KEY)}}\n';
  const env = { HARNESS_API_KEY: 'set-but-unusable' };
  const warnings = [];

  const writes = emit(normalize({ yamlText, env, ...FIXED_INPUTS }), emitterContext({ env, onWarn: (w) => warnings.push(w) }));

  // The harness reads its own credential variable as empty inside MCP headers, so
  // the server would 401 with no explanation. `servers` is still supplied — as
  // null, because it is owned in full and an omission would leave a previously
  // written server in place.
  assert.deepEqual(fileNamed(writes, 'mcp.json').values, { servers: null });
  assert.deepEqual(warnings.map((w) => w.code), ['HEADERS_RESERVED']);
});

test('secret-references keeps the gateway key a reference, not a credential', async () => {
  const { emit } = await emitterFor('secret-references');
  const yamlText = 'models:\n  m: {role: primary, model: x, endpoint: "http://gw:8000"}\n';
  const SECRET = 'sk-langop-agent7.deadbeefcafe';
  const env = { MODEL_API_KEY: SECRET };

  const writes = emit(normalize({ yamlText, env, ...FIXED_INPUTS }), emitterContext({ env }));

  const { gateway } = fileNamed(writes, 'models.json').values.providers;
  assert.equal(gateway.apiKey, '{{env:MODEL_API_KEY}}');
  assert.ok(!JSON.stringify(writes).includes(SECRET), 'models.json lives on the workspace volume; the key must not');
});

test('secret-references keeps an owned mapping valid when the gateway is withdrawn', async () => {
  // `providers` is owned in full, but this harness rejects a models.json without
  // one — so "nothing configured" is an empty map here, not null.
  const { writes } = await emitCase('secret-references', 'minimal');
  assert.deepEqual(fileNamed(writes, 'models.json').values, { providers: {} });
});

// ---------------------------------------------------------------------------
// An adapter may ship a newer emitter than its base
// ---------------------------------------------------------------------------

test('secret-references fails the seed loudly on a base without renderHeaders', async () => {
  const { emit } = await emitterFor('secret-references');
  const { yamlText, env } = loadCase('external-headers');

  // Honest failure: a header-bearing server cannot be configured correctly here,
  // and configuring it anyway would fail later with nothing pointing at the cause.
  assert.throws(() => emit(normalize({ yamlText, env, ...FIXED_INPUTS }), { env }), /renderHeaders/);

  // Tools without headers keep working on such a base.
  const plain = loadCase('sidecar-and-bad-tools');
  const writes = emit(normalize({ yamlText: plain.yamlText, env: plain.env, ...FIXED_INPUTS }), { env: plain.env });
  assert.ok(fileNamed(writes, 'mcp.json').values.servers['service-tool']);
});

test('secret-references degrades rather than fails on a base without renderRef', async () => {
  // Losing per-agent attribution is acceptable; failing the boot over it would
  // make an optional feature a hard dependency on the base version. The contrast
  // with renderHeaders above is the behaviour being pinned.
  const { emit } = await emitterFor('secret-references');
  const yamlText = 'models:\n  m: {role: primary, model: x, endpoint: "http://gw:8000"}\n';
  const env = { MODEL_API_KEY: 'sk-real' };

  const writes = emit(normalize({ yamlText, env, ...FIXED_INPUTS }), { env });

  assert.equal(fileNamed(writes, 'models.json').values.providers.gateway.apiKey, 'sk-langop-proxy');
});

// ---------------------------------------------------------------------------
// A value the harness would execute is never written
// ---------------------------------------------------------------------------

test('secret-references never writes a value its harness would run as a command', async () => {
  // Nothing in the normalized document is validated against a particular
  // harness's quirks — it cannot be, since the quirk belongs to the harness — so
  // guarding against one is the emitter's job. This harness runs any value
  // beginning with `!` as a shell command.
  const { emit } = await emitterFor('secret-references');

  const yamlText = 'tools:\n  ext: {endpoint: https://x.example/mcp, headers: {Authorization: "!cat /etc/passwd"}}\n';
  assert.throws(
    () => emit(normalize({ yamlText, env: {}, ...FIXED_INPUTS }), emitterContext({ env: {} })),
    /shell command/,
  );

  // The gateway key falls back instead of throwing, for the same reason it falls
  // back on an old base: it costs attribution, not correctness.
  const config = normalize({ yamlText: 'models:\n  m: {role: primary, model: x, endpoint: "http://gw:8000"}\n', env: {}, ...FIXED_INPUTS });
  config.gateway.apiKeyRef = '!rm -rf ~';
  const writes = emit(config, emitterContext({ env: {} }));
  assert.equal(fileNamed(writes, 'models.json').values.providers.gateway.apiKey, 'sk-langop-proxy');
});
