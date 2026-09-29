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
 *
 * Rendering is all-or-nothing per tool: a server configured with some of its
 * headers missing looks healthy in the config and fails with a 401 at connect
 * time, with nothing in the log pointing at the cause. So if any header cannot
 * be rendered, nothing is returned and one warning names the reason, and the
 * emitter leaves that server out entirely.
 */

// `$(NAME)` — the operator's reference syntax, borrowed from Kubernetes env
// expansion. Built per call rather than shared: a module-level /g regex carries
// lastIndex state, and a future .test()/.exec() caller would break intermittently.
const envRef = () => /\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g;

/**
 * Render a tool's headers for a client.
 *
 * @param {object|null} headers  `tool.headers` from the normalized document.
 * @param {object}      opts
 * @param {object}      opts.env           The agent container's environment. An unset or
 *                                         empty variable counts as missing (fail closed).
 * @param {Function?}   opts.rewrite       `(name) => string` producing the client's own
 *                                         reference syntax (Claude Code `${NAME}`, OpenCode
 *                                         `{env:NAME}`), so the secret is never written to
 *                                         disk. Omitted, the value is resolved from `env` at
 *                                         seed time — for a client with no such syntax only,
 *                                         since the resolved secret then lands in the harness
 *                                         config on the workspace PVC.
 * @param {RegExp?}     opts.clientSyntax  The client's own interpolation syntax. Text outside
 *                                         a `$(NAME)` reference that already matches it would
 *                                         be expanded by the client, so the header sent would
 *                                         not be the one the spec asked for; it is sent as
 *                                         written, with a HEADER_LITERAL_SYNTAX warning.
 * @param {string[]?}   opts.reserved      Variable names the client refuses to expand (Claude
 *                                         Code reads its own credential variables as empty in
 *                                         MCP headers). A reference to one is unrenderable.
 * @param {Function?}   opts.onWarn        Receives `{ code, path, message }`.
 * @param {string?}     opts.path          Warning path prefix, e.g. `tools.control-plane`.
 * @returns {object|null} The rendered headers, or null when any header could not be
 *                        rendered (or there were none), in which case the emitter must
 *                        not configure the server.
 */
export function renderHeaders(headers, {
  env = {}, rewrite = null, clientSyntax = null, reserved = [], onWarn = () => {}, path = 'headers',
} = {}) {
  if (headers == null || typeof headers !== 'object' || Array.isArray(headers)) return null;

  // Own properties only: a bare `env[name]` read inherits Object.prototype, so
  // `$(constructor)` would be judged set and substitute a function's source.
  const lookup = (name) => (Object.hasOwn(env, name) && env[name] !== '' ? String(env[name]) : undefined);

  const out = {};
  const unset = [];
  const refused = [];
  const literal = [];
  for (const [name, raw] of Object.entries(headers)) {
    const value = String(raw);
    for (const m of value.matchAll(envRef())) {
      if (reserved.includes(m[1])) refused.push(`${name} ($(${m[1]}))`);
      else if (lookup(m[1]) === undefined) unset.push(`${name} ($(${m[1]}))`);
    }
    if (clientSyntax && clientSyntax.test(value.replace(envRef(), ''))) literal.push(name);
    // Function-form replace on purpose: a string replacement would reinterpret
    // `$&`, `$1` and friends inside a resolved secret. Keep it this way.
    out[name] = value.replace(envRef(), (_, ref) => (rewrite ? rewrite(ref) : lookup(ref)));
  }

  if (unset.length > 0) {
    onWarn({
      code: 'HEADERS_UNRESOLVED',
      path: `${path}.headers`,
      message: `header(s) ${unset.join(', ')} reference unset environment variable(s); the server is not configured`,
    });
  }
  if (refused.length > 0) {
    onWarn({
      code: 'HEADERS_RESERVED',
      path: `${path}.headers`,
      message: `header(s) ${refused.join(', ')} reference variable(s) this client refuses to expand in MCP headers; deliver the credential under another name. The server is not configured`,
    });
  }
  if (unset.length > 0 || refused.length > 0) return null;

  if (literal.length > 0) {
    onWarn({
      code: 'HEADER_LITERAL_SYNTAX',
      path: `${path}.headers`,
      message: `header(s) ${literal.join(', ')} contain text the client will interpolate; the header sent may differ from the spec`,
    });
  }
  return Object.keys(out).length > 0 ? out : null;
}
