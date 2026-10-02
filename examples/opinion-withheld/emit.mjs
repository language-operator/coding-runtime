/**
 * Behaviour: a key the runtime only *sometimes* has an opinion about is
 * **omitted**, so provenance protects whatever the user established.
 *
 * This is the shape for a config file the harness and the user also write —
 * a model picked with `/model`, an onboarding marker written by an interactive
 * login. An omitted key falls through to provenance: it is removed only if the
 * value on disk is still the one this runtime wrote, and left alone otherwise.
 *
 * Supplying `null` instead would delete the user's value on every container
 * start. That is not hypothetical — it is the bug that wiped Claude Code login
 * state for a while, and the reason `src/config/provenance.mjs` exists.
 *
 * The rule, then, is not "always supply" or "always omit" but which of the two
 * a given key is. `examples/owned-in-full/` is the other half.
 */

export function emit(config, { env = {} } = {}) {
  const configDir = `${config.paths.stateDir}/opinion-withheld`;

  // Static, and deliberately larger than what any one run supplies. Declaring a
  // key is what permits the runtime to write it at all; it is not a promise to
  // write it every time.
  const owns = ['managedBy', 'model', 'onboardingCompleted', 'account'];

  // One key the runtime always sets, so "the omitted keys were left alone" can be
  // told apart from "nothing was written at all". Without it a test asserting
  // that user state survived would pass against an empty file.
  const values = { managedBy: 'coding-runtime' };

  // The operator configured a model: say so. It configured none: say nothing,
  // because the user may have chosen one in the harness and that choice is not
  // the runtime's to discard.
  if (config.models.primary) {
    values.model = config.models.primary.id;
  }

  // Environmental input arrives through `ctx.env` as data, never a process.env
  // read, so a test can supply it. Here it decides a question of *authority*:
  // with a token the runtime provisioned the session and may mark it onboarded;
  // without one the agent logs in interactively, and telling it that onboarding
  // is complete would skip the flow that obtains its credentials.
  if (env.AGENT_SESSION_TOKEN) {
    values.onboardingCompleted = true;
    values.account = { displayName: config.agent.name };
  }

  return [{ path: `${configDir}/state.json`, values, owns }];
}

export default emit;
