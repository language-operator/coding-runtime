# Examples

Each directory demonstrates **one behaviour** of the emitter contract, in the
smallest emitter that shows it. They are written for this repository and are not
copies of any shipped adapter.

| example | demonstrates |
|---|---|
| `minimal/` | the smallest emitter that works — one file, one owned key. Start here. |
| `owned-in-full/` | a key owned in full is supplied every run, `null` included |
| `opinion-withheld/` | a key the runtime only sometimes has an opinion about is omitted, so provenance protects the user's value |
| `secret-references/` | a credential reaches the harness as a reference, never a value — and what fail-closed means when one cannot be rendered |

`owned-in-full/` and `opinion-withheld/` are two halves of one rule, and the one
most easily got wrong: getting them backwards deleted users' Claude Code login
state on every container start for a while. They are kept as separate examples so
the difference is the first thing you see.

## Why behaviours and not adapters

These directories used to hold byte-identical copies of `claude-code-adapter`,
`opencode-adapter` and `pi-adapter`, reconciled by a weekly drift check. That was
the wrong shape twice over.

As examples they taught nothing: someone writing an adapter needs the smallest
thing that works, not a production emitter carrying conditional OAuth state. As
fixtures they could not do their job, because a regression fixture is only worth
anything if it holds still, and a byte-identical mirror is obliged to move
whenever a downstream edits its emitter for its own reasons — regenerating the
goldens here as a side effect.

It also ran the dependency backwards. Adapters are downstream of this image; they
pin it by tag and digest. A drift check that made their `main` authoritative over
this repository's test corpus put the base downstream of its own consumers.

So: **when a consumer reports a problem in a behaviour, that behaviour gets an
example and a test here. The consumer does not get copied.** A real adapter's
output shape is its own business, verified in its own repository against the base
digest it pins — the one arrangement with no cycle.

For a complete, real adapter — Dockerfile, launch script, Helm chart and all —
read [`claude-code-adapter`](https://github.com/language-operator/claude-code-adapter)
or [`opencode-adapter`](https://github.com/language-operator/opencode-adapter).

## How they are used here

- Every example runs against the shared corpus in `test/fixtures/operator/`, with
  its output goldened under `test/fixtures/golden/emitted/<example>/`. A change to
  the normalizer therefore shows up as a diff in each behaviour at once.
- `test/fixture-adapter/` builds an image from `minimal/`, so adapter-mode
  conformance exercises the documented starting point.
- `docs/authoring-an-adapter.md` is the contract itself, and stands on its own.

## `requires.codingRuntime`

Each example declares the floor **its own behaviour** needs, not a blanket range:

- `minimal/` — `>=0.1.0`, needing nothing beyond a module emitter.
- the other three — `>=0.1.2`, the release that added provenance-aware deletion
  and `$(NAME)` reference rendering (#10, #14).

A real adapter's floor is its own to declare, and is whatever the features it
actually uses require.
