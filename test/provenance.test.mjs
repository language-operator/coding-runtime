import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeManagedJson } from '../src/config/writers.mjs';
import { openProvenance, canonicalize, hashValue, PROVENANCE_FILENAME } from '../src/config/provenance.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'cr-prov-'));

test('a key this runtime never wrote is never deleted', () => {
  // This is issue #11: the emitter declares oauthAccount owned, but supplies it
  // only in token mode. Under an interactive `/login` Claude Code wrote that
  // block, not the runtime — and seeding runs on every container start, so
  // deleting it meant re-running the login wizard every few minutes.
  const dir = scratch();
  const path = join(dir, '.claude.json');
  const provenance = openProvenance(dir);
  writeFileSync(path, JSON.stringify({ oauthAccount: { emailAddress: 'real@example.com' } }));

  for (let boot = 0; boot < 3; boot += 1) {
    writeManagedJson(path, { values: { mcpServers: {} }, owns: ['mcpServers', 'oauthAccount'], provenance });
  }

  assert.deepEqual(
    JSON.parse(readFileSync(path, 'utf8')).oauthAccount,
    { emailAddress: 'real@example.com' },
    'a login must survive an arbitrary number of restarts',
  );
});

test('a key this runtime wrote and still owns is deleted when withdrawn', () => {
  const dir = scratch();
  const path = join(dir, 'config.json');
  const provenance = openProvenance(dir);

  writeManagedJson(path, { values: { mcp: { a: 1 } }, owns: ['mcp'], provenance });
  writeManagedJson(path, { values: {}, owns: ['mcp'], provenance });

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {}, 'dropping the last tool still clears the entry');
});

test('a key the user has since changed is left alone and stops being tracked', () => {
  const dir = scratch();
  const path = join(dir, 'settings.json');
  const provenance = openProvenance(dir);
  const warnings = [];
  const onWarn = (w) => warnings.push(w);

  // The operator configured a model; the runtime wrote it.
  writeManagedJson(path, { values: { model: 'operator-model' }, owns: ['model'], provenance, onWarn });

  // The user picked a different one with `/model`.
  const edited = JSON.parse(readFileSync(path, 'utf8'));
  edited.model = 'user-model';
  writeFileSync(path, JSON.stringify(edited));

  // The operator stops configuring a model.
  writeManagedJson(path, { values: {}, owns: ['model'], provenance, onWarn });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).model, 'user-model', "the user's choice is not the runtime's to delete");
  assert.equal(warnings.filter((w) => w.code === 'OWNED_KEY_DIVERGED').length, 1);

  // Said once, not on every boot — the key is no longer tracked.
  writeManagedJson(path, { values: {}, owns: ['model'], provenance, onWarn });
  assert.equal(warnings.filter((w) => w.code === 'OWNED_KEY_DIVERGED').length, 1, 'divergence is reported once, not per restart');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).model, 'user-model');
});

test('restoring the old value by hand does not make it disappear again', () => {
  const dir = scratch();
  const path = join(dir, 'settings.json');
  const provenance = openProvenance(dir);

  writeManagedJson(path, { values: { model: 'x' }, owns: ['model'], provenance });
  writeFileSync(path, JSON.stringify({ model: 'y' }));          // user edits
  writeManagedJson(path, { values: {}, owns: ['model'], provenance });   // runtime forgets it
  writeFileSync(path, JSON.stringify({ model: 'x' }));          // user happens to set it back

  writeManagedJson(path, { values: {}, owns: ['model'], provenance });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).model, 'x', 'a coincidental match must not resurrect ownership');
});

test('an explicit null deletes regardless of who wrote the value', () => {
  const dir = scratch();
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ stale: 'written by someone else' }));

  writeManagedJson(path, { values: { stale: null }, owns: ['stale'], provenance: openProvenance(dir) });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {}, 'an emitter can still force removal when it means to');
});

test('without a provenance handle nothing is deleted for want of a value', () => {
  const dir = scratch();
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ mcp: { a: 1 } }));

  writeManagedJson(path, { values: {}, owns: ['mcp'] });

  assert.deepEqual(
    JSON.parse(readFileSync(path, 'utf8')),
    { mcp: { a: 1 } },
    'with no way to tell its own writes from the user\'s, the safe answer is to do nothing',
  );
});

test('the record holds no value material, only hashes', () => {
  const dir = scratch();
  const path = join(dir, '.claude.json');
  const provenance = openProvenance(dir);
  const SECRET = 'sk-ant-super-secret-token';

  // The shape an emitter produces when the harness has no env-reference syntax:
  // the resolved credential goes into the config file itself.
  writeManagedJson(path, {
    values: { mcpServers: { ext: { url: 'https://ext.example/mcp', headers: { Authorization: `Bearer ${SECRET}` } } } },
    owns: ['mcpServers'],
    provenance,
  });
  provenance.save();

  const record = readFileSync(join(dir, PROVENANCE_FILENAME), 'utf8');
  assert.ok(!record.includes(SECRET), 'recording values would copy secrets into a second file on the PVC');
  assert.ok(!record.includes('ext.example'), 'not even non-secret value material is stored');
  assert.match(record, /[0-9a-f]{64}/, 'a sha256 stands in for the value');
});

test('re-recording an unchanged write leaves the file byte-identical', () => {
  const dir = scratch();
  const path = join(dir, 'config.json');
  const write = () => {
    const provenance = openProvenance(dir);
    writeManagedJson(path, { values: { b: 2, a: 1 }, owns: ['a', 'b'], provenance });
    return provenance.save();
  };

  write();
  const first = readFileSync(join(dir, PROVENANCE_FILENAME), 'utf8');
  const second = write();

  assert.equal(readFileSync(join(dir, PROVENANCE_FILENAME), 'utf8'), first, 'a no-op restart must not churn the record');
  assert.equal(second.changed, false);
});

test('an unreadable record degrades to deleting nothing', () => {
  const dir = scratch();
  const path = join(dir, 'config.json');
  writeFileSync(join(dir, PROVENANCE_FILENAME), '{ not json');
  writeFileSync(path, JSON.stringify({ mcp: { a: 1 } }));
  const warnings = [];

  const provenance = openProvenance(dir, { onWarn: (w) => warnings.push(w) });
  writeManagedJson(path, { values: {}, owns: ['mcp'], provenance });

  assert.equal(warnings[0].code, 'PROVENANCE_UNREADABLE');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mcp: { a: 1 } }, 'a damaged record must not authorise deletion');
});

test('a record from a future schema is ignored rather than misread', () => {
  const dir = scratch();
  writeFileSync(join(dir, PROVENANCE_FILENAME), JSON.stringify({ schemaVersion: 99, files: { '/x': { k: 'deadbeef' } } }));
  const warnings = [];

  const provenance = openProvenance(dir, { onWarn: (w) => warnings.push(w) });

  assert.equal(warnings[0].code, 'PROVENANCE_UNRECOGNISED');
  assert.equal(provenance.has('/x', 'k'), false);
});

test('hashing is stable across key order, so a harness rewrite is not mistaken for an edit', () => {
  // Claude Code rewrites .claude.json constantly and need not preserve key
  // order. If order changed the hash, every owned key would look user-modified
  // after the first rewrite and could never be cleaned up again.
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(hashValue({ x: { q: 1, p: 2 }, y: [1, 2] }), hashValue({ y: [1, 2], x: { p: 2, q: 1 } }));
  assert.notEqual(hashValue([1, 2]), hashValue([2, 1]), 'array order is meaningful and must still count');
});

test('with no state directory the handle is inert rather than throwing', () => {
  const provenance = openProvenance(null);
  provenance.record('/a', 'k', 1);
  assert.deepEqual(provenance.save(), { path: null, changed: false });
  assert.equal(existsSync('owned.json'), false);
});

test('digests are salted, so the record cannot confirm a guessed value', () => {
  // Two workspaces, same value. Without a per-store salt the digests would
  // match, and a record readable from a backup would reveal that two agents
  // were issued the same credential — or confirm a guess at a low-entropy one.
  const digestFor = () => {
    const dir = scratch();
    const path = join(dir, 'c.json');
    const provenance = openProvenance(dir);
    writeManagedJson(path, { values: { k: 'Bearer shared-token' }, owns: ['k'], provenance });
    provenance.save();
    return JSON.parse(readFileSync(join(dir, PROVENANCE_FILENAME), 'utf8'));
  };

  const a = digestFor();
  const b = digestFor();
  assert.notEqual(a.salt, b.salt, 'each workspace gets its own salt');
  assert.notEqual(
    Object.values(a.files)[0].k,
    Object.values(b.files)[0].k,
    'the same value must not produce the same digest in two workspaces',
  );
});

test('a record whose salt is missing is treated as unknown rather than trusted', () => {
  const dir = scratch();
  const path = join(dir, 'c.json');
  const provenance = openProvenance(dir);
  writeManagedJson(path, { values: { k: 'v' }, owns: ['k'], provenance });
  provenance.save();

  // Strip the salt, as a partial restore or a hand edit might.
  const record = JSON.parse(readFileSync(join(dir, PROVENANCE_FILENAME), 'utf8'));
  delete record.salt;
  writeFileSync(join(dir, PROVENANCE_FILENAME), JSON.stringify(record));

  writeManagedJson(path, { values: {}, owns: ['k'], provenance: openProvenance(dir) });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).k, 'v', 'digests that cannot be verified must not authorise deletion');
});

test('a quarantined file takes its provenance with it', () => {
  const dir = scratch();
  const path = join(dir, 'c.json');
  const provenance = openProvenance(dir);

  writeManagedJson(path, { values: { k: 'ours' }, owns: ['k'], provenance });
  writeFileSync(path, '{ torn');                       // harness corrupts it
  writeManagedJson(path, { values: { k: 'ours' }, owns: ['k'], provenance });   // quarantined, rebuilt

  // The user re-establishes the key by hand in the rebuilt file.
  writeFileSync(path, JSON.stringify({ k: 'theirs' }));
  writeManagedJson(path, { values: {}, owns: ['k'], provenance });

  assert.equal(JSON.parse(readFileSync(path, 'utf8')).k, 'theirs', 'records describing a discarded file must not outlive it');
});
