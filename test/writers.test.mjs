import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeManagedJson, writeOwnedFile, readJsonOr } from '../src/config/writers.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'cr-writers-'));

test('managed keys are merged without disturbing user state', () => {
  const dir = scratch();
  const path = join(dir, 'openclaw.json');
  writeFileSync(path, JSON.stringify({ userKey: 'preserve-me', mcp: { servers: { old: { url: 'http://old' } } } }));

  writeManagedJson(path, {
    values: { 'mcp.servers': { fresh: { url: 'http://fresh' } } },
    owns: ['mcp.servers'],
  });

  const result = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(result.userKey, 'preserve-me', 'user state must survive a re-seed');
  assert.deepEqual(result.mcp.servers, { fresh: { url: 'http://fresh' } }, 'managed keys are replaced wholesale');
});

test('an owned key that is no longer set is removed', () => {
  const dir = scratch();
  const path = join(dir, 'settings.json');
  writeFileSync(path, JSON.stringify({ model: 'old-model', theme: 'dark' }));

  // The LanguageAgent dropped its models section: `model` must go away, not linger.
  writeManagedJson(path, { values: {}, owns: ['model'] });

  const result = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(!('model' in result), 'a managed key with no value must be deleted');
  assert.equal(result.theme, 'dark', 'unmanaged keys are untouched');
});

test('emptied containers are pruned rather than left as husks', () => {
  const dir = scratch();
  const path = join(dir, 'nested.json');
  writeFileSync(path, JSON.stringify({ gateway: { controlUi: { allow: true }, other: 1 } }));

  writeManagedJson(path, { values: {}, owns: ['gateway.controlUi.allow'] });
  let result = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(result, { gateway: { other: 1 } }, 'the empty controlUi mapping is pruned, gateway kept');

  writeManagedJson(path, { values: {}, owns: ['gateway.other'] });
  result = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(result, {}, 'pruning cascades once nothing managed remains');
});

test('setting a key that is not declared owned is refused', () => {
  const dir = scratch();
  assert.throws(
    () => writeManagedJson(join(dir, 'x.json'), { values: { stray: 1 }, owns: [] }),
    /without declaring it in owns/,
    'an undeclared key could never be cleaned up, so writing it is a bug',
  );
});

test('re-seeding is idempotent byte-for-byte', () => {
  const dir = scratch();
  const path = join(dir, 'idempotent.json');
  const call = () => writeManagedJson(path, {
    values: { 'a.b': { x: 1 }, top: 'v' },
    owns: ['a.b', 'top'],
  });

  const first = call();
  const afterFirst = readFileSync(path, 'utf8');
  const second = call();

  assert.equal(readFileSync(path, 'utf8'), afterFirst, 'a pod restart must not churn the file');
  assert.equal(first.changed, true);
  assert.equal(second.changed, false, 'an unchanged write reports no change');
});

test('a corrupt existing file is reported and rebuilt, not fatal', () => {
  const dir = scratch();
  const path = join(dir, 'corrupt.json');
  writeFileSync(path, '{ this is not json');
  const warnings = [];

  writeManagedJson(path, { values: { model: 'm' }, owns: ['model'], onWarn: (w) => warnings.push(w) });

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { model: 'm' });
  assert.equal(warnings[0].code, 'CONFIG_FILE_UNPARSEABLE');
});

test('writes leave no temp files behind', () => {
  const dir = scratch();
  writeManagedJson(join(dir, 'a.json'), { values: { k: 1 }, owns: ['k'] });
  writeOwnedFile(join(dir, 'AGENTS.md'), '# hi\n');

  assert.deepEqual(readdirSync(dir).sort(), ['AGENTS.md', 'a.json']);
});

test('readJsonOr tolerates absent and non-mapping files', () => {
  const dir = scratch();
  assert.deepEqual(readJsonOr(join(dir, 'missing.json')), {});
  writeFileSync(join(dir, 'list.json'), '[1,2]');
  assert.deepEqual(readJsonOr(join(dir, 'list.json')), {});
});
