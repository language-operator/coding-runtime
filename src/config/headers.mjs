/**
 * Headers for external MCP servers.
 *
 * A `spec.tools[]` entry may name a Streamable HTTP server that runs outside
 * the cluster and needs HTTP headers, typically a bearer token. The operator
 * writes the headers into config.yaml verbatim, with `$(NAME)` standing for an
 * environment variable of the agent container (delivered through
 * spec.credentials), so the secret itself never lands in the ConfigMap.
 *
 * The runtime contract (spec/agents.md) is that the runtime substitutes the
 * reference when it connects, and that an unset variable drops the header
 * with a warning rather than sending `$(NAME)` literally. This module is the
 * one place that logic lives; emitters only decide the target syntax.
 */

/** `$(NAME)` — the operator's reference syntax, borrowed from Kubernetes env expansion. */
export const ENV_REF = /\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g;

/**
 * Render a tool's headers for a client.
 *
 * @param {object|null} headers  `tool.headers` from the normalized document.
 * @param {object}      opts
 * @param {object}      opts.env      The agent container's environment.
 * @param {Function?}   opts.rewrite  `(name) => string` producing the client's own
 *                                    reference syntax (Claude Code `${NAME}`, OpenCode
 *                                    `{env:NAME}`). Omitted, the value is resolved from
 *                                    `env` at seed time for clients with no such syntax.
 * @param {Function?}   opts.onWarn   Receives `{ code, path, message }` for each dropped header.
 * @param {string?}     opts.path     Warning path prefix, e.g. `tools.control-plane`.
 * @returns {object|null} The rendered headers, or null when none survive.
 */
export function renderHeaders(headers, { env = {}, rewrite = null, onWarn = () => {}, path = 'headers' } = {}) {
  if (headers == null || typeof headers !== 'object') return null;

  const out = {};
  for (const [name, raw] of Object.entries(headers)) {
    const value = String(raw);
    const missing = [];
    for (const m of value.matchAll(ENV_REF)) {
      if (env[m[1]] === undefined || env[m[1]] === '') missing.push(m[1]);
    }
    if (missing.length > 0) {
      onWarn({
        code: 'HEADER_DROPPED',
        path: `${path}.${name}`,
        message: `header '${name}' references unset environment variable(s) ${missing.join(', ')}; not sent`,
      });
      continue;
    }
    out[name] = value.replace(ENV_REF, (_, ref) => (rewrite ? rewrite(ref) : env[ref]));
  }
  return Object.keys(out).length > 0 ? out : null;
}
