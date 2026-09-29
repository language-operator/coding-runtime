/**
 * What this runtime last wrote, so it can tell its own edits from a user's.
 *
 * `owns` says which keys a runtime reconciles. It cannot, on its own, say what
 * an *absent* value means: dropping the last tool should remove its MCP server
 * entry, but an operator that configures no model must not delete the model the
 * user chose with `/model`, and a runtime that never wrote an onboarding marker
 * has no business deleting one. Those three intentions look identical to a
 * writer that only sees "owned, not supplied".
 *
 * Recording what was written resolves all three without the emitter declaring
 * anything conditionally: a key is deleted only when the value still on disk is
 * the one this runtime put there. Anything else — no record at all, or a value
 * someone has since changed — is left alone.
 *
 * Hashes are stored rather than values. A managed value can carry a secret: an
 * MCP server's headers hold a resolved bearer token whenever the harness has no
 * environment-reference syntax of its own. Recording the value would copy that
 * secret into a second file on the workspace volume.
 *
 * The digests are keyed on a per-workspace random salt rather than being bare
 * hashes, so the record cannot be used to confirm a guessed token, nor to tell
 * that two agents were issued the same one. Losing the salt is harmless: every
 * key simply reads as unknown, and unknown never authorises a deletion.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './writers.mjs';

export const PROVENANCE_SCHEMA_VERSION = 1;
export const PROVENANCE_FILENAME = 'owned.json';

/**
 * Serialize a value with keys in a stable order.
 *
 * Two structurally equal objects must hash the same however the harness
 * happened to order their keys when it rewrote the file, or a key would look
 * user-modified on every boot and never be reclaimable.
 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function hashValue(value, salt = '') {
  return createHmac('sha256', salt).update(canonicalize(value)).digest('hex');
}

/**
 * Open the provenance record kept alongside the debug config snapshot.
 *
 * A missing, unreadable or unrecognised file is not an error: it yields an
 * empty record, and an empty record only ever makes deletion *less* likely.
 * That is what keeps the first seed after an upgrade, and any workspace reset,
 * conservative rather than destructive.
 */
export function openProvenance(stateDir, { onWarn = () => {} } = {}) {
  const path = stateDir ? join(stateDir, PROVENANCE_FILENAME) : null;
  let files = {};
  let salt = null;

  if (path && existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed?.schemaVersion === PROVENANCE_SCHEMA_VERSION && parsed.files != null && typeof parsed.salt === 'string') {
        files = parsed.files;
        salt = parsed.salt;
      } else {
        onWarn({
          code: 'PROVENANCE_UNRECOGNISED',
          path,
          message: `ignoring ${path}: schemaVersion ${JSON.stringify(parsed?.schemaVersion)} is not ${PROVENANCE_SCHEMA_VERSION}. Nothing owned will be deleted until this runtime has written a key itself`,
        });
      }
    } catch (err) {
      onWarn({
        code: 'PROVENANCE_UNREADABLE',
        path,
        message: `could not read ${path} (${err.message}); nothing owned will be deleted until this runtime has written a key itself`,
      });
    }
  }

  // Generated on first use rather than at open, so merely reading the record
  // never rewrites it.
  const saltOf = () => (salt ??= randomBytes(16).toString('hex'));
  const bucket = (file) => (files[file] ??= {});

  return {
    path,

    /** The hash this runtime last wrote for `key` in `file`, or undefined. */
    recordedHash(file, key) {
      return files[file]?.[key];
    },

    /** Has this runtime ever recorded writing `key` in `file`? */
    has(file, key) {
      return files[file]?.[key] !== undefined;
    },

    /**
     * Is `value` still the one this runtime wrote?
     *
     * Hashing lives behind this method so the writer never imports the hasher —
     * provenance already imports the writer's atomic write, and a cycle between
     * the two would be a needless hazard.
     */
    matches(file, key, value) {
      const prior = files[file]?.[key];
      return prior !== undefined && salt !== null && prior === hashValue(value, salt);
    },

    /** Note that this runtime just wrote `value` at `key`. */
    record(file, key, value) {
      bucket(file)[key] = hashValue(value, saltOf());
    },

    /** Stop tracking every key in `file` — its contents were set aside. */
    forgetFile(file) {
      delete files[file];
    },

    /** Stop tracking `key` — it was deleted, or someone else now owns its value. */
    forget(file, key) {
      const entry = files[file];
      if (!entry) return;
      delete entry[key];
      if (Object.keys(entry).length === 0) delete files[file];
    },

    /**
     * Persist the record, with files and keys sorted so an unchanged seed
     * rewrites identical bytes.
     *
     * Deliberately called *after* the config files are written. If this throws,
     * the next run finds no record for the keys just written and declines to
     * delete them — a torn write costs a delayed cleanup, never user state.
     */
    save() {
      if (!path) return { path: null, changed: false };
      const sorted = {};
      for (const file of Object.keys(files).sort()) {
        sorted[file] = Object.fromEntries(Object.keys(files[file]).sort().map((k) => [k, files[file][k]]));
      }
      const record = { schemaVersion: PROVENANCE_SCHEMA_VERSION, salt: saltOf(), files: sorted };
      const contents = `${JSON.stringify(record, null, 2)}\n`;
      const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
      writeFileAtomic(path, contents, 0o600);
      return { path, changed: contents !== before };
    },
  };
}
