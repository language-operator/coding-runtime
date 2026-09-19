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
 *  - *Subtractive*. A key the operator no longer sets must be removed, not
 *    left behind. Drop the last tool from a LanguageAgent and its MCP server
 *    entry has to disappear; otherwise the agent keeps calling a tool that is
 *    gone. This is what `owns` expresses, and it is the part most easily
 *    forgotten when merging by hand.
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

function getPath(obj, path) {
  let node = obj;
  for (const key of segments(path)) {
    if (!isMapping(node) || !(key in node)) return undefined;
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

/** Read a JSON file, treating absent or corrupt content as an empty object. */
export function readJsonOr(path, fallback = {}, onWarn = () => {}) {
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return isMapping(parsed) ? parsed : fallback;
  } catch (err) {
    onWarn({
      code: 'CONFIG_FILE_UNPARSEABLE',
      path,
      message: `could not parse ${path} (${err.message}); rewriting the keys this runtime owns and discarding the rest`,
    });
    return fallback;
  }
}

/**
 * Merge operator-managed values into a JSON file, leaving everything else alone.
 *
 * @param {string} path
 * @param {object} opts
 * @param {object} opts.values  Managed values, keyed by dotted path. `undefined`
 *                              or `null` means "this key is not set right now".
 * @param {string[]} opts.owns  Every path this runtime manages. A path listed
 *                              here but absent from `values` is deleted, which
 *                              is what makes removing a tool actually take effect.
 * @param {number} [opts.indent]
 * @param {function} [opts.onWarn]
 * @returns {{ path: string, changed: boolean }}
 */
export function writeManagedJson(path, { values = {}, owns = [], indent = 2, onWarn = () => {} } = {}) {
  const existing = readJsonOr(path, {}, onWarn);
  const before = JSON.stringify(existing);

  // `values` is an object for the common case, or an array of [path, value]
  // entries when a key needs explicit segments.
  const entries = Array.isArray(values) ? values : Object.entries(values);
  const key = (p) => (Array.isArray(p) ? JSON.stringify(p) : p);
  const wanted = new Map(entries.map(([p, v]) => [key(p), v]));

  for (const owned of owns) {
    const value = wanted.get(key(owned));
    if (value === undefined || value === null) deletePath(existing, owned);
    else setPath(existing, owned, value);
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
