# coding-runtime

The base image the [Language Operator](https://github.com/language-operator/language-operator)
harness adapters build on. It owns the OS layer, the web terminal, and the translation from
the operator's `/etc/agent/config.yaml` into whatever config a given harness reads — so
`claude-code-adapter`, `opencode-adapter` and the rest are a short Dockerfile, a manifest
and an emitter.

Two variants, published from one Dockerfile:

- **thick** (`node:24-slim`) — full unix toolchain, `gh`/`glab`/`tea`, Go, Helm, tmux, and
  the xterm.js/`node-pty` terminal. For interactive terminal coding agents.
- **thin** (`python:3.13-slim`) — the same runtime posture, no Node and no serving
  surface. For headless HTTP agents whose own process is the agent.

`python3`, `uv` and the three forge CLIs are in both variants; the split is about the agent
process's own language and whether it needs a terminal, not about Python's availability.

`gh` and `glab` read their tokens from the environment and need no setup. `tea` does not —
it reads `$XDG_CONFIG_HOME/tea/config.yml`, so a launcher must run `tea login add` first,
and the operator's `forgejo` vendor exports `GITEA_TOKEN` rather than the `GITEA_SERVER_TOKEN`
that login reads. See "Forge CLIs and their tokens" in `README.md`.

## Layout

| path | |
|---|---|
| `src/config/` | the ETL. `normalize.mjs` is the centre of gravity |
| `src/serve/` | the HTTP server and its surfaces (`terminal`, `none`) |
| `src/cli.mjs` | `coding-runtime env \| seed \| serve \| doctor \| version` |
| `examples/` | one emitter per behaviour of the contract — never a copy of a downstream adapter |
| `test/fixtures/` | the shared corpus — operator inputs plus goldens |
| `docs/` | the adapter contract and the normalized config schema |

## Four constraints that explain most of the code

The operator imposes these on every agent container and an adapter cannot override them:

1. **A read-only root filesystem.** Only `/tmp` (a memory-backed emptyDir, capped) and the
   workspace PVC are writable. `HOME`, the XDG directories and every cache are resolved at
   runtime, not baked — and caches go to the PVC, never to `/tmp`.
2. **uid 1000, with no override.** Never create a user in a derived image; the base already
   has a matching passwd entry, and a second user at another uid breaks `getpwuid` and with
   it git, ssh and `gh`.
3. **`/etc/agent/config.yaml` is the only configuration input**, mounted read-only, and its
   schema is exactly `agent`, `instructions`, `personas[]`, `tools{}`, `models{}`.
   `src/config/schema.mjs` holds that contract as data so `validate.mjs` can warn about
   anything else — two adapters once shipped readers for fields that never existed.
4. **The pod is identical in service and task mode**, so `AGENT_EXECUTION_MODE` is the
   only signal; anything but `task` is `service`, unset included. In task mode `serve`
   runs `task.exec` once and exits with its code — but it starts the HTTP server first
   and leaves it up, because probes are not gated on mode and a `startupProbe` on
   `/healthz` (`failureThreshold: 30` at 2s) kills a silent container about 65 seconds in.
   `deepagents-adapter` reached the same two conclusions independently; keep them in step.

## The rule most easily got wrong

`owns` is a **static** list of the keys an emitter manages in a file. What varies is
`values`:

| `values` says | outcome |
|---|---|
| a value | set it |
| `null` | remove it, whoever wrote it |
| nothing | no opinion — removed only if the value on disk is still the one this runtime wrote |

A key the runtime owns **in full** must be supplied every run, `null` included. A key it
only sometimes has an opinion about must be omitted, so provenance protects whatever the
user established. Getting this backwards deleted users' Claude Code login state on every
container start for a while; see `src/config/provenance.mjs` and
`docs/authoring-an-adapter.md`.

Secrets follow a matching rule: the operator's `$(NAME)` references stay opaque in the
normalized document and are rendered by the emitter, so a credential reaches neither the
debug snapshot nor a harness config on the volume.

## Examples demonstrate behaviours, not consumers

`examples/` holds one small emitter per behaviour of the contract. When a consumer
reports a problem in a behaviour, **TDD that behaviour here — do not copy the
downstream adapter.** These directories once held byte-identical mirrors of three
adapter repos, reconciled by a weekly cron; that ran the dependency backwards (the
base downstream of its own consumers) and mutated this repo's regression corpus
whenever a downstream edited its emitter. A real adapter's output shape is verified
in its own repository, against the base digest it pins.

## Working here

```bash
npm ci --ignore-scripts   # node-pty is imported lazily; the unit tier does not need it built
```

The unit tier should catch nearly everything: the config layer takes `(yamlText, env)` and
returns a value, reading no globals and touching no filesystem. That is the property the
four hand-rolled `seed-config` scripts this replaced all lacked, and why none had tests.
`## Testing` below says which tier to run for which change.

## Testing

Mirror the PR CI jobs in `.github/workflows/test.yaml` — `unit`, `shellcheck` and `image`:

- Unit tests: `make test`. The whole config layer is pure over `(yamlText, env)`, so this
  needs no container.
- Goldens: any change to the normalizer or an emitter moves them. `make goldens`, then
  **read the diff before committing it**. The `unit` job fails on stale goldens, and a
  golden regenerated without being read once baked a bug in as the expected value.
- Shell: `make lint` (`shellcheck entrypoint.sh test/conformance.sh`).
- Image, `entrypoint.sh` or `src/serve/` touched: `make conformance`, which builds thick
  and runs the suite under the posture the operator actually imposes — read-only rootfs,
  uid 1000, dropped capabilities. **It needs Docker.** Where Docker is unavailable, say so
  in the PR and let the `image` job cover it; do not report it as passed.
- Normalized schema or emitter contract touched: `claude-code-adapter` and
  `opencode-adapter` ship their own emitters and pin this image by digest, so a change here
  reaches them only when they bump. State in the plan whether they need follow-up issues.
- The PR title must be a conventional commit (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).

## Releasing, and what reaches adapters

Adapters pin this image by **tag and digest**, so nothing here reaches them until they
bump. A real adapter's `requires.codingRuntime` floor is its own to declare, in its own
repository; `examples/*/runtime.json` declares the floor each *behaviour* needs, so raise
one only when that behaviour comes to depend on something a release adds.
`/release major|minor|patch` handles the rest and stops for confirmation before publishing.
