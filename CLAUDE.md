# coding-runtime

The base image the [Language Operator](https://github.com/language-operator/language-operator)
harness adapters build on. It owns the OS layer, the web terminal, and the translation from
the operator's `/etc/agent/config.yaml` into whatever config a given harness reads — so
`claude-code-adapter`, `opencode-adapter` and the rest are a short Dockerfile, a manifest
and an emitter.

Two variants, published from one Dockerfile:

- **thick** (`node:24-slim`) — full unix toolchain, `gh`/`glab`, Go, Helm, tmux, and the
  xterm.js/`node-pty` terminal. For interactive terminal coding agents.
- **thin** (`python:3.13-slim`) — the same runtime posture and `uv`, no Node and no serving
  surface. For headless HTTP agents whose own process is the agent.

## Layout

| path | |
|---|---|
| `src/config/` | the ETL. `normalize.mjs` is the centre of gravity |
| `src/serve/` | the HTTP server and its surfaces (`terminal`, `none`) |
| `src/cli.mjs` | `coding-runtime env \| seed \| serve \| doctor \| version` |
| `examples/` | reference adapters; they double as the authoring documentation |
| `test/fixtures/` | the shared corpus — operator inputs plus goldens |
| `docs/` | the adapter contract and the normalized config schema |

## Three constraints that explain most of the code

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

## Working here

```bash
npm ci --ignore-scripts   # node-pty is imported lazily; the unit tier does not need it built
make test                 # the whole config layer, no container
make goldens              # regenerate fixtures after an intentional change — then read the diff
make lint                 # shellcheck
make build && make conformance   # the image, under the operator's real posture
```

The unit tier should catch nearly everything: the config layer takes `(yamlText, env)` and
returns a value, reading no globals and touching no filesystem. That is the property the
four hand-rolled `seed-config` scripts this replaced all lacked, and why none had tests.

## Releasing, and what reaches adapters

Adapters pin this image by **tag and digest**, so nothing here reaches them until they
bump — and `examples/*/runtime.json` `requires.codingRuntime` declares the floor an
adapter needs. Raise that floor whenever the examples come to depend on something a
release adds, not only when a range would break. `/release major|minor|patch` handles the
rest and stops for confirmation before publishing.
