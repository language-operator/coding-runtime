# Authoring an adapter

An adapter is three files on top of the base image.

## 1. `runtime.json`

Shipped at `/etc/coding-runtime/runtime.json`. It is the only harness-aware
thing the base ever reads, so adding a new harness never means editing the base.

```json
{
  "schemaVersion": 1,
  "name": "claude-code",
  "requires": { "codingRuntime": ">=0.1.0 <1.0.0" },
  "role": "main",
  "env": { "CLAUDE_CONFIG_DIR": "${WORKSPACE}/.claude" },
  "preflight": [{ "path": "${WORKSPACE}/.claude", "mode": "700" }],
  "config": { "emitter": { "type": "module", "path": "/opt/adapter/emit.mjs" } },
  "serve": { "surface": "terminal", "port": 8080, "originGuard": true },
  "terminal": {
    "tmuxSession": "claude",
    "launch": ["launch-claude"],
    "cwd": "${WORKDIR}",
    "keepaliveSeconds": 25
  }
}
```

### Fields

| field | meaning |
|---|---|
| `schemaVersion` | Must be `1`. An unknown version is refused outright rather than half-honoured. |
| `name` | Runtime name, used for the tmux session default and in logs. |
| `requires.codingRuntime` | Semver range the adapter needs. A mismatch warns; it never stops a running agent. |
| `role` | `main` (default) or `init` for an image that only seeds config and exits. |
| `env` | Extra environment for the harness. Applied after the base's own resolution, so it wins. |
| `paths` | Overrides for `home`, `stateDir`, `tmpDir`, `cacheHome`, `dataHome`, `configHome`, `agentConfigPath`. |
| `preflight` | Directories to create before seeding, with an optional octal `mode`. |
| `config.emitter` | `{ "type": "module", "path": … }`, or `{ "type": "none" }` when the harness reads the operator config itself. |
| `serve.surface` | `terminal` or `none`. |
| `serve.port` | Default port. `PORT` in the environment wins. |
| `serve.originGuard` | Enforce the cross-origin check on WebSocket upgrades. Leave it on. |
| `serve.exposeManifest` | Publish the whole manifest at `/runtime.json`. Off by default. |
| `serve.exec` | With `surface: none`, the command the base execs instead of serving. |
| `terminal.launch` | Argv run inside tmux. Required for a terminal surface — the base has no default. |

### Template variables

`${WORKSPACE}`, `${REPO_DIR}`, `${WORKDIR}`, `${HOME}`, `${STATE_DIR}`,
`${TMPDIR}`, `${PORT}`, and anything in the environment. Resolution runs in two
passes, so `${STATE_DIR}` in an `env` value resolves after `paths.stateDir`
itself has resolved against `${WORKSPACE}`. An unresolvable name is left in
place rather than blanked, so a typo is visible instead of silent.

`${WORKDIR}` is the cloned repository when the agent has one and the workspace
root otherwise — which is where a harness should open.

## 2. `emit.mjs`

A module exporting `emit(config, ctx)` that returns write descriptors. It is a
pure function of its arguments: no environment reads, no clock, no filesystem.
Anything environmental arrives through `ctx.env`, so a test can supply it.

```js
export function emit(config, { env = {} } = {}) {
  return [
    {
      path: `${config.paths.workspace}/.claude/settings.json`,
      values: { model: config.models.primary?.id },
      owns: ['model'],
    },
  ];
}
```

### Descriptors

- `{ path, values, owns }` — merge managed keys into a JSON file.
- `{ path, contents }` — write a file the runtime owns outright.
- `{ path, mode }` — ensure a directory exists.

### `owns` is the important part

`owns` lists every path the runtime manages in that file. A path listed in
`owns` but absent from `values` is **deleted**. That is what makes removing the
last tool from a `LanguageAgent` actually remove its MCP server entry, rather
than leaving the agent calling a tool that no longer exists — the case every
hand-rolled merge in the four adapters got wrong or handled ad hoc.

Setting a key without declaring it in `owns` throws, because such a key could
be written but never cleaned up.

`values` may be an object, or an array of `[path, value]` entries when a key
needs explicit segments — Claude Code keys its `projects` map by absolute path,
which cannot be spelled as a dotted string:

```js
values.push([['projects', '/workspace', 'hasTrustDialogAccepted'], true]);
```

## 3. `Dockerfile`

```dockerfile
ARG BASE=ghcr.io/language-operator/coding-runtime:0.1.0
FROM ${BASE}
USER root
RUN npm install -g --no-audit --no-fund <the harness>
COPY runtime.json /etc/coding-runtime/runtime.json
COPY emit.mjs /opt/adapter/emit.mjs
COPY --chmod=755 launch-<harness>.sh /usr/local/bin/launch-<harness>
USER node
```

Pin the base by tag *and* digest in anything you release. Never create a user:
the operator pins the agent container to uid 1000 with no override, and the base
already has a matching passwd entry.

## Testing it

Emitters are pure, so test them with the shared fixture corpus rather than by
building an image:

```js
import { normalize } from 'coding-runtime/src/config/normalize.mjs';
const config = normalize({ yamlText, env });
assert.deepEqual(emit(config, { env }), expected);
```

Then run the conformance suite against the built image. Extract it from the base
your adapter was built on, so the checks match the runtime being checked — and
so the probe it needs comes with it:

```bash
docker run --rm --entrypoint cat ghcr.io/language-operator/coding-runtime:<version> \
  /opt/coding-runtime/test/conformance.sh > conformance.sh
chmod +x conformance.sh
./conformance.sh my-adapter:test adapter
```

In `adapter` mode it runs the image under the posture the operator actually
imposes — `--read-only`, `--user 1000:1000`, `--cap-drop ALL`, tmpfs `/tmp` —
and checks:

- **Posture** — uid 1000 with a passwd entry, a read-only root filesystem, a
  writable `/tmp` and workspace, UTF-8, `tini`, and git not warning about the
  current user.
- **Config** — `doctor` passes, seeding is idempotent, and seeding writes nothing
  outside `/tmp` and the workspace.
- **Serving** — `/healthz`, `/readyz` and `/runtime.json` answer, the manifest is
  redacted, `/ping` is *not* handled (oauth2-proxy would shadow it), and the
  cross-origin guard accepts a same-origin upgrade while rejecting a foreign one.
- **The terminal** — the socket carries traffic both ways, and a typed keystroke
  reaches the program running under tmux.

That last check asks tmux what the pane contains rather than asserting what the
typed text *did*, because the two are not the same question: a shell executes a
line, a TUI puts it in a prompt box, and the base exists to serve both. Nothing
is submitted — no Enter is sent — since a submitted line means something
different, and potentially something destructive, in every terminal program.
