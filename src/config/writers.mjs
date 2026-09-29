/**
 * Writing emitted config, safely and repeatably.
 *
 * Three behaviours the four hand-rolled seed scripts each implemented
 * differently, or not at all:
 *
 *  - *Atomic*. A seed runs again on every pod restart, and the operator
 *    replaces the Workflow whenever the config hash changes. A torn write
 *    leaves a harness unable to parse its own config and no way back.
 *  - *Merge-safe*. Some of these files hold user runtime state alongside
 *    operator-managed keys (openclaw.json most of all), so the seed must edit
 *    its own keys and leave everything else exactly as it found it.
 *  - *Subtractive, but only over its own writes*. A key the operator no longer
 *    sets must be removed: drop the last tool from a LanguageAgent and its MCP
 *    server entry has to disappear, or the agent keeps calling a tool that is
 *    gone. `owns` declares which keys that applies to — but absence alone is
 *    not enough to act on, because "the operator withdrew this" and "the
 *    emitter had nothing to say this run" look identical from here. Deletion is
 *    therefore gated on provenance: a key goes only when the value on disk is
 *    still the one this runtime put there. See provenance.mjs for why that
 *    distinction is load-bearing rather than fussy.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Split an ownership path such as `gateway.controlUi.enabled` into segments.
 *
 * An array may be given instead when a key contains a dot of its own — Claude
 * Code keys its `projects` map by absolute path, for instance, so
 * `['projects', '/workspace/.claude', 'trusted']` cannot be spelled with dots.
 */
const segments = (path) => (Array.isArray(path) ? path : path.split('.').filter(Boolean));

const isMapping = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read the value at an ownership path, or undefined.
 *
 * `Object.hasOwn`, not `in`: JSON.parse output inherits Object.prototype, so
 * `in` answers true for a key named `constructor` or `toString` and returns a
 * function. That is contrived until you notice this function now decides
 * whether a key gets deleted.
 */
function getPath(obj, path) {
  let node = obj;
  for (const key of segments(path)) {
    if (!isMapping(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

function setPath(obj, path, value) {
  const parts = segments(path);
  let node = obj;
  for (const key of parts.slice(0, -1)) {
    if (!isMapping(node[key])) node[key] = {};
    node = node[key];
  }
  node[parts.at(-1)] = value;
}

function deletePath(obj, path) {
  const parts = segments(path);
  const parents = [];
  let node = obj;
  for (const key of parts.slice(0, -1)) {
    if (!isMapping(node[key])) return;
    parents.push([node, key]);
    node = node[key];
  }
  delete node[parts.at(-1)];

  // Prune containers we emptied, so removing the last managed key under
  // `gateway.controlUi` does not leave an orphan `controlUi: {}` behind.
  for (let i = parents.length - 1; i >= 0; i -= 1) {
    const [parent, key] = parents[i];
    if (isMapping(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
    else break;
  }
}

/** Create a directory, tolerating one that already exists with different ownership. */
export function ensureDir(path, mode = 0o755) {
  mkdirSync(path, { recursive: true, mode });
}

/**
 * Replace a file's contents in one step.
 *
 * Writes a sibling temp file and renames over the target: rename(2) within a
 * filesystem is atomic, so a reader either sees the whole old file or the whole
 * new one. The temp file is a sibling rather than in /tmp precisely so the
 * rename never crosses a device — /tmp here is a separate tmpfs mount.
 */
export function writeFileAtomic(path, contents, mode = 0o644) {
  ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${path.split('/').pop()}.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, contents, { mode });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

/**
 * Move a file we cannot parse out of the way, so rewriting it destroys nothing.
 *
 * Without this, an unparseable file becomes `{}` and the next write leaves only
 * managed keys — silently discarding every credential and project record the
 * user had. `.claude.json` is rewritten constantly by Claude Code, including
 * out-of-band while seeding runs, so a torn read is not hypothetical. The
 * quarantined copy is never reaped: these are small and rare, and deleting the
 * evidence would defeat the point.
 */
function quarantine(path, reason, onWarn) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = `${path}.corrupt-${stamp}`;
  for (let n = 1; existsSync(target); n += 1) target = `${path}.corrupt-${stamp}-${n}`;

  try {
    renameSync(path, target);
    onWarn({
      code: 'CONFIG_FILE_QUARANTINED',
      path,
      message: `could not parse ${path} (${reason}); moved it to ${target} and rebuilt it from the keys this runtime owns. The original is intact`,
    });
    return true;
  } catch (err) {
    // "Preserve, then rewrite" has a premise. When preserving fails — a
    // read-only directory, a full volume — rewriting anyway destroys exactly
    // the bytes we just failed to save, so the caller must not.
    onWarn({
      code: 'CONFIG_FILE_UNSALVAGEABLE',
      path,
      message: `could not parse ${path} (${reason}) and could not move it aside (${err.message}); leaving it untouched rather than overwriting it`,
    });
    return false;
  }
}

/**
 * Read a JSON file, treating absent content as empty.
 *
 * Content that is present but unusable is quarantined rather than discarded —
 * see `quarantine`.
 */
export function readJsonOr(path, fallback = {}, onWarn = () => {}) {
  return readJsonFile(path, onWarn).data ?? fallback;
}

/**
 * Read a JSON object, quarantining content that cannot be merged into.
 *
 * @returns {{ data, salvaged, quarantined }} `data` is null when the file was
 * unusable; `salvaged` is false only when it was also impossible to move
 * aside, which means the caller must not overwrite it; `quarantined` says the
 * previous contents were set aside and anything remembered about them is stale.
 */
export function readJsonFile(path, onWarn = () => {}) {
  if (!existsSync(path)) return { data: null, salvaged: true, quarantined: false };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const salvaged = quarantine(path, err.message, onWarn);
    return { data: null, salvaged, quarantined: salvaged };
  }
  if (isMapping(parsed)) return { data: parsed, salvaged: true, quarantined: false };
  // A list or a scalar holds user data just as a mapping does, and merging into
  // it is equally impossible — and this path used to return {} without even a
  // warning, which made it the quieter of the two ways to lose a file.
  const found = Array.isArray(parsed) ? 'an array' : typeof parsed;
  const salvaged = quarantine(path, `expected a JSON object, found ${found}`, onWarn);
  return { data: null, salvaged, quarantined: salvaged };
}

/**
 * Merge operator-managed values into a JSON file, leaving everything else alone.
 *
 * @param {string} path
 * @param {object} opts
 * @param {object} opts.values  Managed values, keyed by dotted path. A key the
 *                              emitter simply does not supply means "no opinion
 *                              this run"; an explicit `null` means "remove it".
 * @param {string[]} opts.owns  Every path this runtime manages. Declaring one
 *                              is safe whether or not it is supplied every run:
 *                              what governs deletion is provenance, not absence.
 * @param {object} [opts.provenance] Handle from `openProvenance`. Without it
 *                              nothing is ever deleted for want of a value,
 *                              because there is no way to tell this runtime's
 *                              own writes from the user's.
 * @param {number} [opts.indent]
 * @param {function} [opts.onWarn]
 * @returns {{ path: string, changed: boolean }}
 */
export function writeManagedJson(path, { values = {}, owns = [], indent = 2, onWarn = () => {}, provenance = null } = {}) {
  const { data, salvaged, quarantined } = readJsonFile(path, onWarn);
  if (!salvaged) return { path, changed: false, skipped: true };

  // Whatever was there is now set aside, so anything remembered about it is
  // stale — and worse, could later authorise deleting a key the user
  // re-establishes by hand in the rebuilt file.
  if (quarantined) provenance?.forgetFile(path);

  const existing = data ?? {};
  const before = JSON.stringify(existing);

  // `values` is an object for the common case, or an array of [path, value]
  // entries when a key needs explicit segments.
  const entries = Array.isArray(values) ? values : Object.entries(values);
  const key = (p) => (Array.isArray(p) ? JSON.stringify(p) : p);
  const wanted = new Map(entries.map(([p, v]) => [key(p), v]));

  for (const owned of owns) {
    const spelling = key(owned);
    const supplied = wanted.has(spelling) ? wanted.get(spelling) : undefined;

    if (supplied !== undefined && supplied !== null) {
      setPath(existing, owned, supplied);
      provenance?.record(path, spelling, supplied);
      continue;
    }

    if (supplied === null) {
      // An explicit null is the emitter saying "remove it" outright, which it
      // may do regardless of who last wrote the value.
      deletePath(existing, owned);
      provenance?.forget(path, spelling);
      continue;
    }

    // No opinion this run. Delete only what this runtime itself put there and
    // nobody has touched since — the rule that lets `owns` stay static without
    // an emitter deleting a user's login state or model choice by omission.
    if (!provenance?.has(path, spelling)) continue;

    const current = getPath(existing, owned);
    if (current === undefined) {
      provenance.forget(path, spelling);
      continue;
    }

    if (provenance.matches(path, spelling, current)) {
      deletePath(existing, owned);
      provenance.forget(path, spelling);
      continue;
    }

    // Changed since we wrote it, so it is no longer ours to remove. Forgetting
    // it means this is said once rather than on every boot, and that restoring
    // the old value by hand later does not make it disappear again.
    provenance.forget(path, spelling);
    onWarn({
      code: 'OWNED_KEY_DIVERGED',
      path: `${path}:${spelling}`,
      message: `'${spelling}' in ${path} has changed since this runtime wrote it; leaving it alone and no longer tracking it`,
    });
  }

  // Any managed path not declared in `owns` is a bug in the emitter: it would be
  // written now and never cleaned up later.
  const ownedKeys = new Set(owns.map(key));
  for (const k of wanted.keys()) {
    if (!ownedKeys.has(k)) {
      throw new Error(`emitter set '${k}' without declaring it in owns; it could never be removed again`);
    }
  }

  const contents = `${JSON.stringify(existing, null, indent)}\n`;
  const changed = JSON.stringify(existing) !== before;
  writeFileAtomic(path, contents);
  return { path, changed };
}

/** Write a whole file the runtime owns outright (instructions, persona markdown). */
export function writeOwnedFile(path, contents, mode = 0o644) {
  writeFileAtomic(path, contents, mode);
  return { path, changed: true };
}
