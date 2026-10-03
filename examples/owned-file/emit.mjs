/**
 * Behaviour: a file the runtime owns **outright** is replaced, not merged — and
 * re-seeding an unchanged one is a no-op.
 *
 * The `{ path, contents }` descriptor is for a file with no user state in it at
 * all: standing instructions, a persona, a generated prompt. There is no `owns`
 * list because there is nothing to negotiate — the runtime's content is the whole
 * file, so the next seed replaces it.
 *
 * It is also the only honest descriptor for a harness whose config is not JSON.
 * `{ path, values, owns }` merges *into* parsed JSON, so pointing it at a YAML or
 * `.env` file would quarantine that file the moment the harness rewrote it in its
 * own format, taking the user's edits with it.
 *
 * Withdrawal is stated, not implied: when the operator supplies no instructions
 * the file is written **empty** rather than left behind, so standing context the
 * operator removed stops being in force. Skipping the write would leave the last
 * run's instructions governing an agent that is no longer meant to have them.
 *
 * Re-seeding is a no-op because `writeOwnedFile` compares the bytes first. An
 * adapter needs that to pass the conformance check `seed is idempotent`, which
 * greps a second seed for `unchanged`.
 *
 * The declared floor is `>=0.1.0`, because this descriptor has always *worked*.
 * The no-op part arrives in 0.1.7: before it, `writeOwnedFile` reported every
 * write as a change, and an adapter whose only descriptor was this one could not
 * pass `seed is idempotent` at all. That is what hermes-adapter hit on 0.1.4.
 */

export function emit(config) {
  const configDir = `${config.paths.stateDir}/owned-file`;

  // Persona is the identity half and instructions the task half; both are
  // standing context rather than a first message, so the harness opens with the
  // agent already briefed instead of depending on when the user first types.
  const standing = [config.systemPrompt, config.instructions].filter(Boolean).join('\n\n');

  return [
    {
      path: `${configDir}/AGENTS.md`,
      contents: standing ? `${standing}\n` : '',
    },
  ];
}

export default emit;
