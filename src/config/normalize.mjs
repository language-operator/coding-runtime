/**
 * Turn the operator's agent config plus its environment into one normalized
 * document that every adapter's emitter consumes.
 *
 * Deliberately pure: it takes the file's text and an env *map*, never reads
 * process.env, and never touches the filesystem. That is the whole reason the
 * four hand-rolled seed-config scripts this replaces had no unit tests — they
 * each read process.env from module scope, so exercising a case meant spawning
 * a container.
 */

import { parseAgentConfig, splitList } from './load.mjs';
import { validateAgentConfig } from './validate.mjs';
import { GATEWAY_PLACEHOLDER_KEY } from './schema.mjs';

export const NORMALIZED_SCHEMA_VERSION = 1;

const trimOrNull = (v) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

const isMapping = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

const stripTrailingSlashes = (url) => url.replace(/\/+$/, '');

/**
 * Render a persona exactly as the operator renders AGENT_PERSONA.
 *
 * Byte-for-byte equivalent to formatPersona (languageagent_config.go:690-705),
 * including the unconditional trailing period on each line. Emitters must use
 * this rather than re-deriving it, so an agent's identity is identical whether
 * a harness reads the env var or the config file.
 */
export function formatPersona(persona) {
  if (!isMapping(persona)) return '';
  const lines = [];
  for (const field of ['tone', 'personality', 'expertise']) {
    const value = trimOrNull(persona[field]);
    if (value) lines.push(`${field[0].toUpperCase()}${field.slice(1)}: ${value}.`);
  }
  return lines.join('\n');
}

/** Render a persona as markdown, for harnesses bootstrapped from files rather than flags. */
function personaMarkdown(persona) {
  if (!isMapping(persona)) return null;
  const name = trimOrNull(persona.name);
  const parts = [`# ${name ?? 'Persona'}`];
  for (const [field, label] of [['tone', 'Tone'], ['personality', 'Personality'], ['expertise', 'Expertise']]) {
    const value = trimOrNull(persona[field]);
    if (value) parts.push(`**${label}:** ${value}`);
  }
  return parts.length > 1 ? `${parts.join('\n\n')}\n` : null;
}

function normalizePersona(raw, fallbackText) {
  if (isMapping(raw)) {
    const text = formatPersona(raw);
    return {
      name: trimOrNull(raw.name),
      tone: trimOrNull(raw.tone),
      personality: trimOrNull(raw.personality),
      expertise: trimOrNull(raw.expertise),
      text: text === '' ? null : text,
      markdown: personaMarkdown(raw),
    };
  }
  // No persona in the config, but the operator still exported AGENT_PERSONA —
  // carry the text through with no structured fields behind it.
  if (fallbackText) {
    return { name: null, tone: null, personality: null, expertise: null, text: fallbackText, markdown: null };
  }
  return null;
}

/**
 * Canonical model ordering: declared primary first, then ascending priority,
 * then declaration order.
 *
 * This is the single decision that resolves a live disagreement — claude-code's
 * seed-config takes whichever key the YAML mapping happened to yield first,
 * while deepagents' agent_config honours `role: primary`. Given the same input
 * the two runtimes select different models today.
 */
function orderModels(models) {
  return Object.entries(models)
    .filter(([, m]) => isMapping(m))
    .map(([key, m], index) => {
      const priority = typeof m.priority === 'number' && Number.isFinite(m.priority) ? m.priority : Infinity;
      return {
        index,
        sortKey: [trimOrNull(m.role) === 'primary' ? 0 : 1, priority, index],
        model: {
          key,
          role: trimOrNull(m.role),
          provider: trimOrNull(m.provider),
          // The operator writes spec.modelName here; the CRD key is the fallback.
          id: trimOrNull(m.model) ?? key,
          endpoint: trimOrNull(m.endpoint),
          priority: priority === Infinity ? null : priority,
        },
      };
    })
    .sort((a, b) => {
      for (let i = 0; i < 3; i += 1) {
        if (a.sortKey[i] !== b.sortKey[i]) return a.sortKey[i] < b.sortKey[i] ? -1 : 1;
      }
      return 0;
    })
    .map((e) => e.model);
}

/**
 * Derive the gateway from the models section, falling back to MODEL_ENDPOINT.
 *
 * Every model routes through one per-namespace LiteLLM gateway
 * (serviceURL("gateway", ns, 8000) in languageagent_workflow.go), so the first
 * endpoint found is the endpoint. Three base URLs are exposed rather than one
 * because the two client shapes append different paths, and because whether a
 * given harness uses the gateway at all is currently a live question —
 * claude-code deliberately bypasses it. Making both forms available keeps that
 * an emitter's explicit choice instead of something this function decides.
 */
function deriveGateway(ordered, env) {
  const fromModels = ordered.find((m) => m.endpoint)?.endpoint ?? null;
  const fromEnv = splitList(env.MODEL_ENDPOINT)[0] ?? null;
  const endpoint = fromModels ?? fromEnv;
  if (!endpoint) return null;

  const baseUrl = stripTrailingSlashes(endpoint);
  return {
    baseUrl,
    // OpenAI-shaped clients append /chat/completions to this.
    openaiBaseUrl: `${baseUrl}/v1`,
    // Anthropic-shaped clients append /v1/messages to this.
    anthropicBaseUrl: baseUrl,
    apiKey: GATEWAY_PLACEHOLDER_KEY,
    source: fromModels ? 'config' : 'env',
  };
}

/** Derive a tool name from its URL, matching how the env-var fallback has always named them. */
function nameFromUrl(url) {
  try {
    return new URL(url).hostname.split('.')[0] || url;
  } catch {
    return url;
  }
}

function isHttpUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

function isLocalUrl(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function normalizeTools(config, env, warnings) {
  const tools = [];
  const fromConfig = isMapping(config.tools) ? config.tools : {};

  for (const [name, tool] of Object.entries(fromConfig)) {
    if (!isMapping(tool)) continue;
    const endpoint = trimOrNull(tool.endpoint);
    if (!endpoint) {
      warnings.push({ code: 'TOOL_SKIPPED', path: `tools.${name}`, message: `tool '${name}' has no endpoint; skipping` });
      continue;
    }
    if (!isHttpUrl(endpoint)) {
      warnings.push({
        code: 'TOOL_SKIPPED',
        path: `tools.${name}`,
        message: `tool '${name}' endpoint '${endpoint}' is not an HTTP URL; skipping`,
      });
      continue;
    }
    tools.push({
      name,
      endpoint,
      protocol: trimOrNull(tool.protocol) ?? 'mcp',
      // The operator bridges stdio tools to Streamable HTTP, so from here every
      // tool looks the same, and the /mcp path is already part of the endpoint.
      transport: 'streamable-http',
      local: isLocalUrl(endpoint),
    });
  }

  if (tools.length > 0) return tools;

  for (const url of splitList(env.MCP_SERVERS)) {
    if (!isHttpUrl(url)) {
      warnings.push({ code: 'TOOL_SKIPPED', path: 'MCP_SERVERS', message: `'${url}' is not an HTTP URL; skipping` });
      continue;
    }
    tools.push({ name: nameFromUrl(url), endpoint: url, protocol: 'mcp', transport: 'streamable-http', local: isLocalUrl(url) });
  }
  return tools;
}

function derivePaths(env, overrides = {}) {
  const workspace = overrides.workspace ?? '/workspace';
  const repoDir = trimOrNull(env.AGENT_REPO_DIR);
  return {
    workspace,
    repoDir,
    // Where the harness should open. The operator already sets the container's
    // WorkingDir to AGENT_REPO_DIR when a repository is configured.
    workDir: repoDir ?? workspace,
    home: overrides.home ?? `${workspace}/.home`,
    stateDir: overrides.stateDir ?? `${workspace}/.coding-runtime`,
    // Caches belong on the PVC: /tmp is a memory-medium emptyDir with no
    // sizeLimit, so filling it OOM-kills the pod instead of returning ENOSPC.
    tmpDir: overrides.tmpDir ?? `${workspace}/.tmp`,
    cacheHome: overrides.cacheHome ?? `${workspace}/.cache`,
    dataHome: overrides.dataHome ?? `${workspace}/.local/share`,
    configHome: overrides.configHome ?? `${workspace}/.config`,
    agentConfigPath: overrides.agentConfigPath ?? '/etc/agent/config.yaml',
  };
}

/**
 * @param {object}   input
 * @param {string?}  input.yamlText              Contents of /etc/agent/config.yaml, or null.
 * @param {object}   input.env                   Environment as a plain map.
 * @param {string?}  input.runtimeName           Adapter name from runtime.json.
 * @param {string?}  input.codingRuntimeVersion  Base image version.
 * @param {object?}  input.paths                 Resolved path overrides from the manifest.
 * @param {string?}  input.now                   ISO timestamp, injectable for deterministic tests.
 */
export function normalize({ yamlText, env = {}, runtimeName = null, codingRuntimeVersion = null, paths = {}, now = null } = {}) {
  const { config, warnings: parseWarnings } = parseAgentConfig(yamlText);
  const warnings = [...parseWarnings, ...validateAgentConfig(config)];

  const personasRaw = Array.isArray(config.personas) ? config.personas : [];
  const envPersona = trimOrNull(env.AGENT_PERSONA);
  const persona = normalizePersona(personasRaw[0], envPersona);
  const personas = personasRaw.map((p) => normalizePersona(p, null)).filter(Boolean);

  const modelsRaw = isMapping(config.models) ? config.models : {};
  // Kept separate from `ordered` below so the gateway can report honestly
  // whether it came from the config file or was rebuilt from the environment.
  const orderedFromConfig = orderModels(modelsRaw);
  let ordered = orderedFromConfig;

  // No models section: reconstruct what we can from the comma-separated env pair.
  if (ordered.length === 0) {
    const endpoint = splitList(env.MODEL_ENDPOINT)[0] ?? null;
    ordered = splitList(env.LLM_MODEL).map((id, index) => ({
      key: id,
      role: index === 0 ? 'primary' : null,
      provider: null,
      id,
      endpoint,
      priority: null,
    }));
  }

  const gateway = deriveGateway(orderedFromConfig, env);
  const tools = normalizeTools(config, env, warnings);

  const agent = isMapping(config.agent) ? config.agent : {};
  const instructions = trimOrNull(config.instructions) ?? trimOrNull(env.AGENT_INSTRUCTIONS);

  return {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    meta: {
      codingRuntimeVersion,
      runtimeName,
      generatedAt: now,
      warnings,
    },
    agent: {
      name: trimOrNull(agent.name) ?? trimOrNull(env.AGENT_NAME),
      namespace: trimOrNull(agent.namespace) ?? trimOrNull(env.AGENT_NAMESPACE),
      uuid: trimOrNull(env.AGENT_UUID),
      clusterName: trimOrNull(env.AGENT_CLUSTER_NAME),
      clusterUuid: trimOrNull(env.AGENT_CLUSTER_UUID),
    },
    // The task to carry out, kept distinct from the identity to adopt. Harnesses
    // consume them differently: one is an opening message or an instructions
    // file, the other is a system-prompt append.
    instructions,
    systemPrompt: persona?.text ?? null,
    persona,
    personas,
    gateway,
    models: {
      primary: ordered[0] ?? null,
      ordered,
      byKey: Object.fromEntries(ordered.map((m) => [m.key, m])),
    },
    tools,
    paths: derivePaths(env, paths),
  };
}
