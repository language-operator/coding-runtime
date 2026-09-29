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

test('an unset or empty variable drops the header with a warning, never sends $(NAME) literally', () => {
  const warnings = [];
  const out = renderHeaders(
    { Keep: '$(TOKEN)', Unset: 'Bearer $(NOPE)', Empty: '$(EMPTY)' },
    { env, onWarn: (w) => warnings.push(w), path: 'tools.t', rewrite: (n) => `\${${n}}` },
  );
  assert.deepEqual(out, { Keep: '${TOKEN}' });
  assert.deepEqual(warnings.map((w) => [w.code, w.path]), [
    ['HEADER_DROPPED', 'tools.t.Unset'],
    ['HEADER_DROPPED', 'tools.t.Empty'],
  ]);
  assert.ok(warnings[0].message.includes('NOPE'));
});

test('nothing to send yields null, and non-objects are tolerated', () => {
  assert.equal(renderHeaders(null, { env }), null);
  assert.equal(renderHeaders({}, { env }), null);
  assert.equal(renderHeaders({ Only: '$(NOPE)' }, { env }), null);
  assert.equal(renderHeaders('nope', { env }), null);
});

test('references only match well-formed $(NAME); other dollar forms pass through', () => {
  const out = renderHeaders({ A: '$TOKEN ${TOKEN} $(1bad) $()' }, { env, rewrite: () => 'X' });
  assert.deepEqual(out, { A: '$TOKEN ${TOKEN} $(1bad) $()' });
});

test('emitterContext binds the environment and the warning channel', () => {
  const warnings = [];
  const ctx = emitterContext({ env, onWarn: (w) => warnings.push(w) });
  assert.equal(ctx.env, env);
  assert.deepEqual(ctx.renderHeaders({ A: '$(TOKEN)', B: '$(NOPE)' }, { path: 'tools.x' }), { A: 'abc' });
  assert.deepEqual(warnings.map((w) => w.path), ['tools.x.B']);
});
