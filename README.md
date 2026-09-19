# coding-runtime

The base image for [Language Operator](https://github.com/language-operator/language-operator)
harness adapters. It owns the things every adapter needs and none of them should
be writing twice: the OS and tool layer, the web terminal, and the translation
from the operator's `/etc/agent/config.yaml` into whatever config a given
harness actually reads.

An adapter built on it is a short Dockerfile, a manifest, and an emitter.

## Why

Four adapter repos — `claude-code-adapter`, `opencode-adapter`,
`openclaw-adapter`, `deepagents-adapter` — each reimplemented the same five
things. The cost was not the duplication itself but the drift:

- The cross-origin WebSocket fix (`fb22e8d`) landed in `claude-code-adapter` and
  never reached `opencode-adapter`, whose `server.mjs` is otherwise
  byte-identical — leaving a live cross-site hijacking hole behind the shared
  OIDC proxy.
- `openclaw-adapter` reads six persona fields the operator has never emitted,
  and never writes `instructions` at all, so its agents receive no task.
- `claude-code-adapter` and `deepagents-adapter` disagree about which model is
  primary: one takes the first mapping key, the other honours `role: primary`.
- No adapter wires `PORT`, so every chart's `.Values.port` is decorative.
- No adapter sends WebSocket keepalives, so an idle terminal dies to the
  ingress's 60s read timeout.

Each of those is fixed once here.

## Variants

| tag | shape | for |
|---|---|---|
| `ghcr.io/language-operator/coding-runtime:X.Y.Z` | **thick** — `node:24-slim`, full unix toolchain, `gh`/`glab`, Go, Helm, tmux, the web terminal | interactive terminal coding agents |
| `…:X.Y.Z-python` | **thin** — `python:3.13-slim`, `uv`, the same runtime posture, no Node | headless HTTP agents whose own process is the agent |

They have different parents and share no layers. That is deliberate: no node
runs both shapes expecting deduplication. What they share is the contract — the
normalized config schema, the fixture corpus, and the uid/`HOME`/cache posture —
not bytes.

## Building an adapter

```dockerfile
ARG BASE=ghcr.io/language-operator/coding-runtime:0.1.0
FROM ${BASE}
USER root
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code && npm cache clean --force
COPY runtime.json /etc/coding-runtime/runtime.json
COPY emit.mjs /opt/adapter/emit.mjs
COPY --chmod=755 launch-claude.sh /usr/local/bin/launch-claude
USER node
```

See [`examples/`](examples/) for working `runtime.json` and `emit.mjs` pairs for
claude-code and opencode, and [docs/authoring-an-adapter.md](docs/authoring-an-adapter.md)
for the walkthrough.

## What the base does at startup

`entrypoint.sh` runs three steps:

1. **`coding-runtime env`** — resolves `HOME`, the XDG directories and every
   cache path. These cannot be baked into the image: the agent container runs
   with `readOnlyRootFilesystem: true` as uid 1000, and only `/tmp` and the
   workspace PVC are writable.
2. **`coding-runtime seed`** — reads `/etc/agent/config.yaml`, validates it
   against the operator's real schema, normalizes it, and hands the result to
   the adapter's emitter.
3. **`coding-runtime serve`** — runs the serving surface the manifest names.

Seeding happens in the agent container rather than an init container, because
there is nothing an init container could hand over: the operator mounts `/tmp`
only into the agent container, so the two share no writable path. The normalized
config is a pure function of the config file and the environment, both of which
the agent container already has.

## Commands

| command | does |
|---|---|
| `coding-runtime env` | print the resolved environment as shell exports |
| `coding-runtime seed` | translate the operator config into the harness's native config |
| `coding-runtime serve` | run the serving surface from the manifest |
| `coding-runtime doctor` | check the image against the constraints the operator imposes |
| `coding-runtime version` | print the base version |

`doctor` is the one to reach for when an adapter misbehaves in-cluster: it
asserts the uid, the passwd entry, the read-only rootfs, the manifest, and the
emitter, and says which of them is wrong.

## Endpoints

Every serving surface exposes `/healthz`, `/readyz` and `/runtime.json`. Those
names are chosen, not incidental: oauth2-proxy v7.6.0 intercepts `/ping` and
`/ready` (as well as `/oauth2/*`) before the upstream ever sees them, so a
runtime using those names would have probes answered by the proxy rather than
the agent.

`/runtime.json` is redacted by default — it would otherwise publish the exact
command line the agent runs, on an endpoint that is public whenever
`auth.enabled` is false.

## Development

```bash
npm ci --ignore-scripts   # node-pty is imported lazily; the unit tier does not need it built
npm test                  # the whole config layer, no container required
make goldens              # regenerate golden fixtures after an intentional change
make build                # build the thick image
make conformance          # run the in-image suite against it
```

The unit tier is the one that should catch almost everything: the config layer
takes `(config text, env map)` and returns a value, reading no globals and
touching no filesystem. That is the property the four hand-rolled `seed-config`
scripts lacked, and the reason none of them had tests.

## Documentation

- [Authoring an adapter](docs/authoring-an-adapter.md) — the manifest, the
  emitter contract, and what `owns` is for.
- [The normalized config](docs/config-schema.md) — what the operator actually
  emits, what the normalizer produces, and the decisions baked into it.

## Open questions

Two decisions are deliberately left visible rather than settled in code:

- **Does `claude-code` route through the LiteLLM gateway?** Today it does not —
  it talks to `api.anthropic.com` via `/login` or `CLAUDE_CODE_OAUTH_TOKEN`
  while the operator's whole credential model assumes the gateway. The
  normalized config exposes both an OpenAI-shaped and an Anthropic-shaped
  gateway base URL so this stays an emitter's explicit choice.
- **Does `openclaw` get vendored into an image built on this base?** That is
  what would let it stop running an unpinned upstream `latest` and gain probes.
  Until then it uses the base as an init-role image.
