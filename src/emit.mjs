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
 */

import { pathToFileURL } from 'node:url';

import { writeManagedJson, writeOwnedFile, ensureDir } from './config/writers.mjs';

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

/** Apply the descriptors an emitter returned. */
export function applyWrites(descriptors, { onWarn = () => {} } = {}) {
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
    results.push({ ...writeManagedJson(d.path, { values: d.values, owns: d.owns, onWarn }), kind: 'json' });
  }
  return results;
}
