/**
 * The operator's agent-config contract, as data.
 *
 * Transcribed from agentConfigYAML and friends in
 * language-operator/src/controllers/languageagent_config.go:29-60. Those Go
 * structs are the only thing that ever writes /etc/agent/config.yaml, so this
 * is the complete set of keys an adapter can rely on — anything else in the
 * file was either hand-written or hallucinated.
 *
 * Keeping it as data rather than as parsing code is what lets `validate.mjs`
 * report unknown keys instead of silently ignoring them, which is how
 * openclaw-adapter came to read six persona fields that have never existed and
 * deepagents-adapter came to read `a2a`/`peers`.
 */

export const AGENT_CONFIG_SCHEMA = {
  root: {
    agent: 'mapping',
    instructions: 'scalar',
    personas: 'list',
    tools: 'map-of-mapping',
    models: 'map-of-mapping',
  },
  agent: ['name', 'namespace'],
  persona: ['name', 'tone', 'personality', 'expertise'],
  tool: ['endpoint', 'protocol', 'headers'],
  model: ['role', 'provider', 'model', 'endpoint', 'priority'],
};

/**
 * Environment variables the operator injects into every agent container.
 * `PORT` is deliberately absent — the operator never sets it
 * (buildAgentEnv, languageagent_config.go:553+), which is why every adapter's
 * chart `.Values.port` is decorative today.
 */
export const OPERATOR_ENV = [
  'AGENT_NAME',
  'AGENT_NAMESPACE',
  'AGENT_UUID',
  'AGENT_CLUSTER_NAME',
  'AGENT_CLUSTER_UUID',
  'AGENT_REPO_DIR',
  'AGENT_INSTRUCTIONS',
  'AGENT_PERSONA',
  'MODEL_ENDPOINT',
  'LLM_MODEL',
  'MCP_SERVERS',
];

/** The placeholder every adapter sends to the LiteLLM gateway; real keys live in the gateway pod. */
export const GATEWAY_PLACEHOLDER_KEY = 'sk-langop-proxy';

/**
 * Where a per-agent gateway key arrives when one is issued.
 *
 * Deliberately absent from OPERATOR_ENV above: the operator injects
 * MODEL_ENDPOINT but not this, which reaches the container through
 * spec.credentials or spec.deployment.env. Its presence therefore means
 * somebody deliberately issued a credential.
 */
export const GATEWAY_API_KEY_VAR = 'MODEL_API_KEY';
