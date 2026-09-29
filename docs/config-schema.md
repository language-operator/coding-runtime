# The normalized config

`coding-runtime seed` turns `/etc/agent/config.yaml` plus the operator's
environment into one document, and hands it to the adapter's emitter. A copy is
written to `${STATE_DIR}/config.json` as a **debug artifact** — nothing reads it
back. Any other container re-derives it from the same inputs rather than
trusting a file it did not write.

## What the operator actually emits

Transcribed from `agentConfigYAML` in
`language-operator/src/controllers/languageagent_config.go:29-60`. This is the
complete set of keys; anything else in the file was hand-written or imagined.

```yaml
agent:        { name, namespace }
instructions: <string>
personas:     [ { name, tone, personality, expertise } ]
tools:        { <name>: { endpoint, protocol, headers } }
models:       { <key>: { role, provider, model, endpoint, priority } }
```

Keys outside that set produce an `UNKNOWN_KEY` warning and are ignored. The
warning is how two shipping adapters' phantom fields were found.

## Shape

```jsonc
{
  "schemaVersion": 1,
  "meta": { "codingRuntimeVersion", "runtimeName", "generatedAt", "warnings": [] },
  "agent": { "name", "namespace", "uuid", "clusterName", "clusterUuid" },

  // The task to carry out.
  "instructions": "…",
  // The identity to adopt — byte-identical to the operator's AGENT_PERSONA.
  "systemPrompt": "Tone: professional.\nPersonality: …",
  "persona": { "name", "tone", "personality", "expertise", "text", "markdown" },
  "personas": [ /* 0 or 1 entries; see below */ ],

  "gateway": {
    "baseUrl":          "http://gateway.<ns>.svc.cluster.local:8000",
    "openaiBaseUrl":    "…:8000/v1",   // OpenAI clients append /chat/completions
    "anthropicBaseUrl": "…:8000",      // Anthropic clients append /v1/messages
    "apiKey": "sk-langop-proxy",        // always the placeholder, never a credential
    "apiKeyRef": "$(MODEL_API_KEY)",    // or null when no per-agent key is issued
    "source": "config" | "env"
  },

  "models": { "primary": {…} | null, "ordered": [ … ], "byKey": { … } },
  "tools": [ { "name", "endpoint", "protocol", "transport", "local", "headers" } ],
  "paths": { "workspace", "repoDir", "workDir", "home", "stateDir", "tmpDir",
             "cacheHome", "dataHome", "configHome", "agentConfigPath" }
}
```

Every field is present-or-`null`, so an emitter never has to defend against a
missing key.

## Decisions baked in

**Model ordering.** `models.ordered` is `role: primary` first, then ascending
`priority`, then declaration order; `models.primary` is its first element. This
resolves a live disagreement: `claude-code-adapter` takes whichever key the YAML
mapping yielded first, while `deepagents-adapter` honours the role, so the two
select different models from identical input.

**Two gateway base URLs.** Whether a harness uses the cluster gateway at all is
currently an open question — `claude-code` deliberately bypasses it. Exposing
both client shapes keeps that an emitter's explicit choice rather than something
normalization decides silently.

**Persona is rendered once.** `persona.text` is byte-for-byte what the operator
puts in `AGENT_PERSONA` (`formatPersona`, `languageagent_config.go:690-705`),
including the trailing period on each line. Emitters must use it rather than
re-deriving it, so an agent's identity is identical whether the harness reads
the env var or the file. `persona.markdown` is the rendering for harnesses
bootstrapped from files.

**`personas` is never longer than one.** `spec.persona` is a single reference
and the operator resolves exactly one, writing it as the sole list element.
Multi-persona merging logic is dead code.

**`instructions` and `systemPrompt` are separate** — the task versus the
identity. Harnesses consume them differently: one as an opening message or an
instructions file, the other as a system-prompt append.

**Tools are already complete.** MCP endpoints include the `/mcp` path, and the
operator bridges stdio tools to Streamable HTTP, so every tool looks the same
from here. `local` is true for a sidecar-mode tool resolved to `localhost`.

**Headers are not substituted here.** An external server (`spec.tools[].url`)
may carry `headers`, a string map, in which `$(NAME)` refers to an environment
variable of the agent container. Normalization passes the references through
untouched — the secret must not appear in the `config.json` debug snapshot —
and the emitter renders them with `ctx.renderHeaders`, choosing the client's
own reference syntax where it has one (Claude Code `${NAME}`, OpenCode
`{env:NAME}`) or resolving from the environment at seed time where it does not.
Rendering is all-or-nothing per tool: if any header references a variable
that is unset or empty (or one the client refuses to expand, such as Claude
Code's own credential names), the whole server is left out of the client's
config with one `HEADERS_UNRESOLVED` / `HEADERS_RESERVED` warning, rather than
configured without auth to fail with an unexplained 401. `$(NAME)` is never
sent literally. Resolving at seed time writes the secret into the harness
config on the workspace PVC, so an emitter should prefer `rewrite` whenever the
client has a syntax. `MCP_SERVERS` never lists a server that needs headers, so
the config file is the only source for them.

**The gateway key is a reference, not a value.** `apiKey` is always the shared
placeholder. When the deployment supplies `MODEL_API_KEY` — through
`spec.credentials` or `spec.deployment.env`; the operator does not inject it —
`apiKeyRef` carries `$(MODEL_API_KEY)` and the emitter decides how to render it.
Resolving it here would put the credential in this document, which is written to
`${STATE_DIR}/config.json`, *and* in whatever the emitter writes beside it. Same
reasoning as tool headers.

**Caches point at the PVC.** `/tmp` is a memory-backed emptyDir with no
`sizeLimit`, so filling it OOM-kills the pod rather than returning `ENOSPC`.
Nothing cache-shaped may live there.
