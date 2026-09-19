/**
 * The shared fixture corpus.
 *
 * Both the JS normalizer and the Python one are held to this same set of
 * inputs, which is what makes "one contract, two implementations" a checkable
 * claim rather than an aspiration. A case is a `<name>.yaml` config, a
 * `<name>.env.json` environment, or both; either may be absent.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const OPERATOR_DIR = join(FIXTURE_DIR, 'operator');
export const GOLDEN_DIR = join(FIXTURE_DIR, 'golden');

export function caseNames() {
  const names = new Set();
  for (const file of readdirSync(OPERATOR_DIR)) {
    if (file.endsWith('.env.json')) names.add(file.slice(0, -'.env.json'.length));
    else if (file.endsWith('.yaml')) names.add(file.slice(0, -'.yaml'.length));
  }
  return [...names].sort();
}

export function loadCase(name) {
  const yamlPath = join(OPERATOR_DIR, `${name}.yaml`);
  const envPath = join(OPERATOR_DIR, `${name}.env.json`);
  return {
    name,
    // null, not "", so the absent-file path is exercised rather than the empty-file one.
    yamlText: existsSync(yamlPath) ? readFileSync(yamlPath, 'utf8') : null,
    env: existsSync(envPath) ? JSON.parse(readFileSync(envPath, 'utf8')) : {},
  };
}

/**
 * Normalizer inputs held constant across every case, so a golden diff only ever
 * reflects a real change in normalization rather than a moving clock or version.
 */
export const FIXED_INPUTS = {
  runtimeName: 'fixture',
  codingRuntimeVersion: '0.0.0-test',
  now: '2026-01-01T00:00:00.000Z',
};
