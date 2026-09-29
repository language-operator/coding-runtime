/**
 * Running an adapter's emitter.
 *
 * An emitter is a plain module exporting `emit(config, ctx) => WriteDescriptor[]`.
 * It is a pure function of its arguments: no env reads, no clock, no filesystem.
 * Anything environmental it needs — Claude Code checks for an OAuth token, for
 * instance — arrives through `ctx.env` as data, so a test can supply it. That is what lets an adapter test its config generation with a
 * fixture and a golden file instead of building an image and grepping the
 * result, which is how all four adapters test this today.
 *
 * A descriptor is one of:
 *   { path, values, owns }  — merge managed keys into a JSON file
 *   { path, contents }      — write a file the runtime owns outright
 *
 * Within a merged file, `owns` is a static list of every key the runtime
 * manages, and `values` says what it wants each to be *this run*:
 *
 *   supplied a value  — set it
 *   supplied null     — remove it, whoever last wrote it
 *   not supplied      — no opinion; removed only if the value on disk is still
 *                       the one this runtime wrote (see config/provenance.mjs)
 *
 * The third case is the one to get right. A key the runtime owns in full should
 * be supplied every run, null included, so "nothing here now" is stated rather
 * than implied. A key it only sometimes has an opinion about — an onboarding
 * marker written only in token mode, a model only when the operator configures
 * one — should be omitted, and provenance will protect whatever the user has.
 */

import { pathToFileURL } from 'node:url';

import { writeManagedJson, writeOwnedFile, ensureDir } from './config/writers.mjs';
import { renderHeaders, renderRef } from './config/headers.mjs';

/**
 * The `ctx` an emitter receives: the environment as data, plus `renderHeaders`
 * bound to that environment and to the runtime's warning channel, so an emitter
 * can translate a tool's `$(NAME)` header references without reading
 * process.env or logging itself. Tests build the same object with a collector.
 */
export function emitterContext({ env = {}, onWarn = () => {} } = {}) {
  return {
    env,
    renderHeaders: (headers, opts = {}) => renderHeaders(headers, { env, onWarn, ...opts }),
    renderRef: (value, opts = {}) => renderRef(value, { env, onWarn, ...opts }),
  };
}

export async function loadEmitter(emitter) {
  if (!emitter || emitter.type === 'none') return null;
  if (emitter.type !== 'module') throw new Error(`unsupported emitter type '${emitter.type}'`);

  const mod = await import(pathToFileURL(emitter.path).href);
  const fn = mod.emit ?? mod.default;
  if (typeof fn !== 'function') {
    throw new Error(`emitter ${emitter.path} exports no 'emit' function`);
  }
  return fn;
}

/**
 * Apply the descriptors an emitter returned.
 *
 * `provenance` is threaded down to every managed-JSON write, because deciding
 * whether an owned key may be deleted needs to know what this runtime last
 * wrote there. Omitted, writes still happen and nothing is ever deleted for
 * want of a value.
 */
export function applyWrites(descriptors, { onWarn = () => {}, provenance = null } = {}) {
  const results = [];
  for (const d of descriptors ?? []) {
    if (!d || typeof d.path !== 'string') {
      throw new Error(`emitter returned a write with no path: ${JSON.stringify(d)}`);
    }
    if (d.mode !== undefined && d.contents === undefined && d.values === undefined) {
      ensureDir(d.path, d.mode);
      results.push({ path: d.path, kind: 'dir', changed: true });
      continue;
    }
    if (d.contents !== undefined) {
      results.push({ ...writeOwnedFile(d.path, d.contents), kind: 'file' });
      continue;
    }
    results.push({ ...writeManagedJson(d.path, { values: d.values, owns: d.owns, onWarn, provenance }), kind: 'json' });
  }
  return results;
}
