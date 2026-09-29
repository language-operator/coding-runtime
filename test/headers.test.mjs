import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderHeaders } from '../src/config/headers.mjs';
import { emitterContext } from '../src/emit.mjs';

const env = { TOKEN: 'abc', OTHER: 'xyz', EMPTY: '' };

test('rewrite mode hands each reference to the client syntax without touching the value', () => {
  const out = renderHeaders(
    { Authorization: 'Bearer $(TOKEN)', 'X-Two': '$(TOKEN)/$(OTHER)', Plain: 'no refs' },
    { env, rewrite: (name) => `{env:${name}}` },
  );
  assert.deepEqual(out, { Authorization: 'Bearer {env:TOKEN}', 'X-Two': '{env:TOKEN}/{env:OTHER}', Plain: 'no refs' });
});

test('resolve mode substitutes from the environment at seed time', () => {
  assert.deepEqual(renderHeaders({ Authorization: 'Bearer $(TOKEN)' }, { env }), { Authorization: 'Bearer abc' });
});

test('a resolved secret is inserted verbatim, never reinterpreted as a replacement pattern', () => {
  const out = renderHeaders({ A: 'x$(S)y' }, { env: { S: '$& $1 $$ $<n>' } });
  assert.deepEqual(out, { A: 'x$& $1 $$ $<n>y' });
});

test('an unset or empty variable makes the whole set unrenderable, with one warning naming it', () => {
  const warnings = [];
  const out = renderHeaders(
    { Keep: '$(TOKEN)', Unset: 'Bearer $(NOPE)', Empty: '$(EMPTY)' },
    { env, onWarn: (w) => warnings.push(w), path: 'tools.t', rewrite: (n) => `\${${n}}` },
  );
  assert.equal(out, null, 'a partially authenticated server must not be configured');
  assert.deepEqual(warnings.map((w) => [w.code, w.path]), [['HEADERS_UNRESOLVED', 'tools.t.headers']]);
  assert.ok(warnings[0].message.includes('Unset ($(NOPE))') && warnings[0].message.includes('Empty ($(EMPTY))'));
  assert.ok(!warnings[0].message.includes('Keep'));
});

test('inherited Object.prototype names are not environment variables', () => {
  const warnings = [];
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const out = renderHeaders({ Bad: `X $(${name})` }, { env: { ...env }, onWarn: (w) => warnings.push(w) });
    assert.equal(out, null, `$(${name}) must be treated as unset`);
  }
  assert.equal(warnings.length, 5);
  assert.ok(warnings.every((w) => w.code === 'HEADERS_UNRESOLVED'));
  // ...but an own property of that name is a real variable.
  assert.deepEqual(renderHeaders({ Ok: '$(constructor)' }, { env: { constructor: 'v' } }), { Ok: 'v' });
});

test('a reserved name the client refuses to expand is unrenderable even when set', () => {
  const warnings = [];
  const out = renderHeaders(
    { Authorization: 'Bearer $(ANTHROPIC_API_KEY)' },
    { env: { ANTHROPIC_API_KEY: 'set' }, reserved: ['ANTHROPIC_API_KEY'], rewrite: (n) => `\${${n}}`, onWarn: (w) => warnings.push(w), path: 'tools.t' },
  );
  assert.equal(out, null);
  assert.deepEqual(warnings.map((w) => [w.code, w.path]), [['HEADERS_RESERVED', 'tools.t.headers']]);
});

test('text that already matches the client syntax is sent as written, with a warning', () => {
  const warnings = [];
  const out = renderHeaders(
    { A: 'Bearer $(TOKEN) via ${HOME}', B: '{env:X}', C: '$(TOKEN)' },
    { env, rewrite: (n) => `\${${n}}`, clientSyntax: /\$\{/, onWarn: (w) => warnings.push(w), path: 'tools.t' },
  );
  assert.deepEqual(out, { A: 'Bearer ${TOKEN} via ${HOME}', B: '{env:X}', C: '${TOKEN}' });
  assert.deepEqual(warnings.map((w) => [w.code, w.path]), [['HEADER_LITERAL_SYNTAX', 'tools.t.headers']]);
  assert.ok(warnings[0].message.includes('A') && !warnings[0].message.includes('C'));
});

test('nothing to send yields null, and non-objects are tolerated', () => {
  assert.equal(renderHeaders(null, { env }), null);
  assert.equal(renderHeaders({}, { env }), null);
  assert.equal(renderHeaders('nope', { env }), null);
  assert.equal(renderHeaders(['a'], { env }), null);
});

test('references only match well-formed $(NAME); other dollar forms pass through', () => {
  const out = renderHeaders({ A: '$TOKEN ${TOKEN} $(1bad) $()' }, { env, rewrite: () => 'X' });
  assert.deepEqual(out, { A: '$TOKEN ${TOKEN} $(1bad) $()' });
});

test('emitterContext binds the environment and the warning channel', () => {
  const warnings = [];
  const ctx = emitterContext({ env, onWarn: (w) => warnings.push(w) });
  assert.equal(ctx.env, env);
  assert.deepEqual(ctx.renderHeaders({ A: '$(TOKEN)' }, { path: 'tools.x' }), { A: 'abc' });
  assert.equal(ctx.renderHeaders({ B: '$(NOPE)' }, { path: 'tools.y' }), null);
  assert.deepEqual(warnings.map((w) => w.path), ['tools.y.headers']);
});
