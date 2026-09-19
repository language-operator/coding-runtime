/**
 * Check a parsed agent config against the operator's real schema.
 *
 * Never throws and never fails a boot: unknown keys are reported as warnings so
 * an adapter that is reading a field the operator does not emit shows up in the
 * pod log on the very first start, rather than silently producing an empty
 * prompt for months.
 */

import { AGENT_CONFIG_SCHEMA as S } from './schema.mjs';

const isMapping = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export function validateAgentConfig(config) {
  const warnings = [];
  const unknown = (path, message) => warnings.push({ code: 'UNKNOWN_KEY', path, message });
  const wrongType = (path, message) => warnings.push({ code: 'WRONG_TYPE', path, message });

  if (!isMapping(config)) return warnings;

  for (const key of Object.keys(config)) {
    if (!(key in S.root)) {
      unknown(key, `'${key}' is not emitted by language-operator and will be ignored`);
    }
  }

  if ('agent' in config) {
    if (!isMapping(config.agent)) {
      wrongType('agent', `'agent' should be a mapping`);
    } else {
      for (const key of Object.keys(config.agent)) {
        if (!S.agent.includes(key)) {
          unknown(`agent.${key}`, `'agent.${key}' is not emitted by language-operator and will be ignored`);
        }
      }
    }
  }

  if ('personas' in config) {
    if (!Array.isArray(config.personas)) {
      wrongType('personas', `'personas' should be a list`);
    } else {
      config.personas.forEach((persona, i) => {
        if (!isMapping(persona)) {
          wrongType(`personas[${i}]`, `'personas[${i}]' should be a mapping`);
          return;
        }
        for (const key of Object.keys(persona)) {
          if (!S.persona.includes(key)) {
            unknown(
              `personas[${i}].${key}`,
              `'personas[].${key}' is not emitted by language-operator (a persona is only ${S.persona.join('/')}) and will be ignored`,
            );
          }
        }
      });
      if (config.personas.length > 1) {
        warnings.push({
          code: 'UNEXPECTED_SHAPE',
          path: 'personas',
          message: `${config.personas.length} personas present; the operator resolves the single spec.persona reference, so only the first is meaningful`,
        });
      }
    }
  }

  for (const [section, allowed] of [['tools', S.tool], ['models', S.model]]) {
    if (!(section in config)) continue;
    if (!isMapping(config[section])) {
      wrongType(section, `'${section}' should be a mapping keyed by name`);
      continue;
    }
    for (const [name, entry] of Object.entries(config[section])) {
      if (!isMapping(entry)) {
        wrongType(`${section}.${name}`, `'${section}.${name}' should be a mapping`);
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (!allowed.includes(key)) {
          unknown(
            `${section}.${name}.${key}`,
            `'${section}.<name>.${key}' is not emitted by language-operator and will be ignored`,
          );
        }
      }
    }
  }

  return warnings;
}
