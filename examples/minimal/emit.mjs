/**
 * The smallest emitter that works.
 *
 * One managed JSON file, one owned key, no conditionals. Start here when writing
 * an adapter: everything else in `examples/` adds exactly one behaviour to this
 * shape, and `docs/authoring-an-adapter.md` walks through the contract itself.
 *
 * `emit` is a pure function of `(config, ctx)`. It reads no environment, no
 * clock and no filesystem — anything environmental arrives through `ctx`, which
 * is what lets a test call it with a fixture and compare the result to a golden
 * instead of building an image and grepping inside it.
 *
 * It returns descriptors rather than writing anything itself. The runtime
 * applies them, so provenance, atomic replacement and the read-only rootfs are
 * its problem and not an adapter's.
 */

export function emit(config) {
  // `config.paths` is resolved at runtime, never baked: the container has a
  // read-only root filesystem, so the only writable places are the workspace
  // volume and /tmp. Deriving the path from `stateDir` is what keeps an adapter
  // working when the operator moves it.
  const configDir = `${config.paths.stateDir}/minimal`;

  return [
    {
      path: `${configDir}/settings.json`,
      // `owns` is static — it describes the adapter, not this boot. `values`
      // says what each owned key should be *now*: a value sets it, `null`
      // removes it. Here the runtime owns `model` in full, so it is supplied on
      // every run and becomes `null` when the operator configures no model.
      owns: ['model'],
      values: { model: config.models.primary?.id ?? null },
    },
  ];
}

export default emit;
