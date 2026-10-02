/**
 * Behaviour: a key the runtime owns **in full** is supplied on every run,
 * `null` included.
 *
 * This is the shape for a config file that holds no user state — the operator's
 * intent is the whole content, so the runtime can state it completely each time.
 * Every key in `owns` below appears in `values` on every run, set to `null` when
 * there is nothing to configure.
 *
 * `null` removes a key *whoever last wrote it*. That is the difference that
 * matters: omitting the key instead would fall through to provenance, and a key
 * with no provenance record is never deleted — so a model or tool the operator
 * withdrew before the adapter moved to a provenance-aware base would sit in the
 * file forever rather than for one boot.
 *
 * Compare `examples/opinion-withheld/`, which is the opposite case and the
 * opposite rule. Getting these two backwards is the mistake this corpus exists
 * to catch: it once deleted users' Claude Code login state on every container
 * start.
 */

export function emit(config) {
  const configDir = `${config.paths.stateDir}/owned-in-full`;

  // Declared once, statically. `owns` describes the adapter, so it does not
  // depend on what happened to be configured this boot — which is exactly why
  // every one of these keys has to be answered below.
  const owns = ['model', 'models', 'servers', 'instructions'];

  // Start from "nothing configured" and let the operator's config overwrite it.
  // Written this way round on purpose: a key can only be forgotten by adding it
  // to `owns` and never assigning it, which this shape makes visible.
  const values = {
    model: null,
    models: null,
    servers: null,
    instructions: null,
  };

  if (config.models.primary) {
    values.model = config.models.primary.id;
  }
  if (config.models.ordered.length > 0) {
    values.models = config.models.ordered.map((m) => m.id);
  }
  if (config.tools.length > 0) {
    // `tool.headers` is ignored here on purpose: this example is about the
    // ownership rule and nothing else. A real emitter must render headers —
    // see `examples/secret-references/` — because a server configured without
    // the credential it needs looks healthy and 401s at connect time.
    values.servers = Object.fromEntries(config.tools.map((t) => [t.name, { url: t.endpoint }]));
  }
  if (config.instructions) {
    values.instructions = config.instructions;
  }

  return [{ path: `${configDir}/config.json`, values, owns }];
}

export default emit;
