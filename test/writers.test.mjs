import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeManagedJson, writeOwnedFile, readJsonOr } from '../src/config/writers.mjs';
import { openProvenance } from '../src/config/provenance.mjs';

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

test('an owned key this runtime wrote is removed once it stops being supplied', () => {
  const dir = scratch();
  const path = join(dir, 'settings.json');
  const provenance = openProvenance(dir);
  writeFileSync(path, JSON.stringify({ theme: 'dark' }));

  // First seed writes the model and records having done so.
  writeManagedJson(path, { values: { model: 'old-model' }, owns: ['model'], provenance });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).model, 'old-model');

  // The LanguageAgent dropped its models section: `model` must go away, not linger.
  writeManagedJson(path, { values: {}, owns: ['model'], provenance });

  const result = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(!('model' in result), 'a key this runtime wrote and no longer supplies must be deleted');
  assert.equal(result.theme, 'dark', 'unmanaged keys are untouched');
});

test('emptied containers are pruned rather than left as husks', () => {
  const dir = scratch();
  const path = join(dir, 'nested.json');
  writeFileSync(path, JSON.stringify({ gateway: { controlUi: { allow: true }, other: 1 } }));

  // Explicit nulls: the emitter saying "remove these", which needs no provenance.
  writeManagedJson(path, { values: { 'gateway.controlUi.allow': null }, owns: ['gateway.controlUi.allow'] });
  let result = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(result, { gateway: { other: 1 } }, 'the empty controlUi mapping is pruned, gateway kept');

  writeManagedJson(path, { values: { 'gateway.other': null }, owns: ['gateway.other'] });
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

test('a corrupt existing file is quarantined, not discarded', () => {
  const dir = scratch();
  const path = join(dir, 'corrupt.json');
  // Stands in for a torn read of a file the harness rewrites out of band.
  writeFileSync(path, '{"credentials":"precious", "oops');
  const warnings = [];

  writeManagedJson(path, { values: { model: 'm' }, owns: ['model'], onWarn: (w) => warnings.push(w) });

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { model: 'm' }, 'the agent still gets a usable config');
  assert.equal(warnings[0].code, 'CONFIG_FILE_QUARANTINED');

  const saved = readdirSync(dir).filter((f) => f.startsWith('corrupt.json.corrupt-'));
  assert.equal(saved.length, 1, `expected the original to be set aside, found ${readdirSync(dir).join(', ')}`);
  assert.match(readFileSync(join(dir, saved[0]), 'utf8'), /precious/, 'the user bytes must survive verbatim');
});

test('a file that parses to a non-mapping is quarantined too', () => {
  const dir = scratch();
  const path = join(dir, 'list.json');
  writeFileSync(path, '["user","data"]');
  const warnings = [];

  writeManagedJson(path, { values: { model: 'm' }, owns: ['model'], onWarn: (w) => warnings.push(w) });

  assert.equal(warnings[0].code, 'CONFIG_FILE_QUARANTINED');
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('list.json.corrupt-')).length, 1);
});

test('writes leave no temp files behind', () => {
  const dir = scratch();
  writeManagedJson(join(dir, 'a.json'), { values: { k: 1 }, owns: ['k'] });
  writeOwnedFile(join(dir, 'AGENTS.md'), '# hi\n');

  assert.deepEqual(readdirSync(dir).sort(), ['AGENTS.md', 'a.json']);
});

test('an owned file reports a real change, and a re-seed of the same bytes does not', () => {
  // `coding-runtime seed` logs `unchanged` only for a write reporting
  // changed: false, and the conformance check `seed is idempotent` greps a second
  // seed for that word. While this returned an unconditional true, an adapter
  // whose harness config is not JSON could never pass it — hermes-adapter#3.
  const dir = scratch();
  const path = join(dir, 'config.yaml');

  const created = writeOwnedFile(path, 'model: sonnet\n');
  assert.equal(created.changed, true, 'a file that did not exist is a change');
  assert.equal(readFileSync(path, 'utf8'), 'model: sonnet\n');

  const again = writeOwnedFile(path, 'model: sonnet\n');
  assert.equal(again.changed, false, 'the same bytes a second time are not a change');

  const edited = writeOwnedFile(path, 'model: opus\n');
  assert.equal(edited.changed, true, 'different bytes are still written');
  assert.equal(readFileSync(path, 'utf8'), 'model: opus\n');
});

test('an unchanged owned file is genuinely not rewritten', () => {
  // Reporting `changed: false` while still rewriting would satisfy the log and
  // keep churning the file, so assert the file itself was left alone.
  const dir = scratch();
  const path = join(dir, 'AGENTS.md');
  writeOwnedFile(path, 'standing context\n');
  const before = statSync(path).mtimeNs;

  assert.equal(writeOwnedFile(path, 'standing context\n').changed, false);
  assert.equal(statSync(path).mtimeNs, before, 'an unchanged file must not be touched');
});

test('an owned file that cannot be read is written rather than skipped', () => {
  // Any failure to compare counts as "differs", so an odd state falls through to
  // the write this did unconditionally before. A directory in the way is the
  // reachable case: the write then fails loudly instead of silently reporting
  // that nothing needed doing.
  const dir = scratch();
  const path = join(dir, 'AGENTS.md');
  mkdirSync(path);

  assert.throws(() => writeOwnedFile(path, 'x\n'), 'a directory in the way must not read as unchanged');
});

test('an owned file is compared as bytes, not as a decoded string', () => {
  // Emitters hand over strings today, but comparing through a decode would make
  // the answer depend on an encoding assumption.
  const dir = scratch();
  const path = join(dir, 'persona.md');
  writeOwnedFile(path, 'Tone: café ☕\n');

  assert.equal(writeOwnedFile(path, 'Tone: café ☕\n').changed, false, 'multi-byte content compares equal to itself');
  assert.equal(writeOwnedFile(path, 'Tone: cafe ☕\n').changed, true);
});

test('readJsonOr tolerates an absent file without quarantining anything', () => {
  const dir = scratch();
  assert.deepEqual(readJsonOr(join(dir, 'missing.json')), {});
  assert.deepEqual(readdirSync(dir), [], 'nothing to preserve, nothing created');
});
