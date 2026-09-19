/**
 * Parse the operator-injected agent config.
 *
 * The operator mounts exactly one file, read-only, at /etc/agent/config.yaml
 * (language-operator/src/controllers/languageagent_config.go:62-137). A missing
 * or unparseable file is not fatal: every adapter today degrades to an empty
 * config and starts anyway, and an agent that boots without tools is far more
 * useful than one that crashfails on a malformed ConfigMap.
 */

import { parse as parseYaml } from 'yaml';

/**
 * @param {string|null} yamlText  Raw file contents, or null when absent.
 * @returns {{ config: object, warnings: Array<{code: string, path: string, message: string}> }}
 */
export function parseAgentConfig(yamlText) {
  const warnings = [];

  if (yamlText == null) {
    warnings.push({
      code: 'CONFIG_ABSENT',
      path: '',
      message: 'no agent config present; falling back to environment variables only',
    });
    return { config: {}, warnings };
  }

  let parsed;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    warnings.push({
      code: 'CONFIG_UNPARSEABLE',
      path: '',
      message: `could not parse agent config as YAML (${err.message}); falling back to environment variables only`,
    });
    return { config: {}, warnings };
  }

  // A YAML document can legally parse to null (empty file) or to a scalar.
  // Only a mapping is a usable config.
  if (parsed == null) return { config: {}, warnings };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push({
      code: 'CONFIG_NOT_A_MAPPING',
      path: '',
      message: `agent config parsed as ${Array.isArray(parsed) ? 'a list' : typeof parsed}, expected a mapping; ignoring it`,
    });
    return { config: {}, warnings };
  }

  return { config: parsed, warnings };
}

/** Split a comma-separated operator env var into trimmed, non-empty parts. */
export function splitList(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
