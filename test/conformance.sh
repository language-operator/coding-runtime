#!/usr/bin/env bash
# Conformance suite for a coding-runtime image, or any adapter image built on one.
#
#     test/conformance.sh <image> [base|adapter]
#
# The container flags are not incidental — they reproduce the posture the
# operator imposes and that an adapter cannot override: uid 1000, a read-only
# root filesystem, all capabilities dropped, and /tmp as a small tmpfs. Every
# adapter has hit some part of this in production and patched around it
# privately; the point of one suite is that the next one does not have to.
#
# Single quotes around each check body are deliberate: the command is passed to
# `sh -c` *inside* the container, so $(id -u) and friends must reach it
# unexpanded. Expanding them on the host would assert the wrong thing.
# shellcheck disable=SC2016

set -euo pipefail

IMAGE="${1:?usage: conformance.sh <image> [base|adapter]}"
MODE="${2:-base}"
WORKDIR="$(mktemp -d)"
CONTAINER="conformance-$$"
PASS=0
FAIL=0

cleanup() {
    local status=$?
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    # The container runs as uid 1000 and writes into the bind-mounted workspace,
    # so those files belong to a user the caller may not be — on a CI runner it
    # never is. Remove them from inside a root container, then clear the rest.
    docker run --rm -v "$WORKDIR:/w" --user 0:0 --entrypoint sh "$IMAGE" \
        -c 'rm -rf /w/workspace /w/etc-agent' >/dev/null 2>&1 || true
    rm -rf "$WORKDIR" 2>/dev/null || true
    # Preserve the suite's own verdict: a cleanup that cannot delete a scratch
    # directory must not turn a passing run red.
    return "$status"
}
trap cleanup EXIT

check() {
    local desc="$1"; shift
    local out
    # Captured rather than discarded: a failing check in CI is useless without
    # the reason, and the container is gone by the time anyone looks.
    if out="$("$@" 2>&1)"; then
        echo "  ok    $desc"
        PASS=$((PASS + 1))
    else
        echo "  FAIL  $desc"
        if [ -n "$out" ]; then
            printf '%s\n' "$out" | sed 's/^/          | /' | tail -12
        else
            echo "          | (no output)"
        fi
        FAIL=$((FAIL + 1))
    fi
}

# Same constraints as the agent container. --user 1000:1000 rather than
# 1000:101, because fsGroup is a pod-level supplementary group rather than the
# process gid; what has to match is the uid.
run() {
    docker run --rm \
        --read-only --tmpfs /tmp:rw,size=64m \
        --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
        -v "$WORKDIR/workspace:/workspace" \
        -v "$WORKDIR/etc-agent:/etc/agent:ro" \
        -e AGENT_NAME=conformance -e AGENT_NAMESPACE=default \
        -e HOME=/workspace/.home \
        --entrypoint sh "$IMAGE" -c "$1"
}

# The image's real ENTRYPOINT, rather than sh -c. Worth exercising separately:
# a CLI that silently does nothing still exits 0, so every check that only
# inspects an exit status passes against a completely inert binary.
run_entrypoint() {
    docker run --rm \
        --read-only --tmpfs /tmp:rw,size=64m \
        --user 1000:1000 --cap-drop ALL \
        -v "$WORKDIR/workspace:/workspace" \
        -v "$WORKDIR/etc-agent:/etc/agent:ro" \
        -e AGENT_NAME=conformance -e HOME=/workspace/.home \
        "$IMAGE" 2>&1
}

# Does this image carry the Node runtime, or is it a thin (Python) base?
has_cli() {
    docker run --rm --entrypoint sh "$IMAGE" -c 'command -v coding-runtime' >/dev/null 2>&1
}

mkdir -p "$WORKDIR/workspace" "$WORKDIR/etc-agent"
# The CI runner owns these directories as a different uid than the container
# runs as, so grant write access explicitly. In a cluster this is the PVC, which
# arrives group-writable via fsGroup.
chmod 777 "$WORKDIR/workspace"
# These checks bypass the entrypoint, so nothing has resolved HOME for them.
# Docker leaves HOME as / for a numeric --user, which is read-only here — and a
# tool that wants to create a config directory (glab does) then fails for a
# reason that never occurs in a real pod, where the entrypoint sets HOME first.
mkdir -p "$WORKDIR/workspace/.home"
chmod 777 "$WORKDIR/workspace/.home"

cat > "$WORKDIR/etc-agent/config.yaml" <<'YAML'
agent:
  name: conformance
  namespace: default
instructions: Confirm the runtime works.
models:
  primary-model:
    role: primary
    provider: anthropic
    model: claude-sonnet-4-5
    endpoint: http://gateway.default.svc.cluster.local:8000
tools:
  a-tool:
    endpoint: http://a-tool.tools.svc.cluster.local:8080/mcp
    protocol: mcp
YAML

echo "== identity and filesystem posture =="
check "runs as uid 1000"                 run '[ "$(id -u)" = 1000 ]'
check "uid 1000 has a passwd entry"      run 'getent passwd 1000'
check "the login shell exists"           run '[ -x "$(getent passwd 1000 | cut -d: -f7)" ]'
check "root filesystem is read-only"     run '! touch /probe 2>/dev/null'
check "/etc is read-only"                run '! touch /etc/probe 2>/dev/null'
check "/opt/coding-runtime is read-only" run '! touch /opt/coding-runtime/probe 2>/dev/null'
check "/tmp is writable"                 run 'touch /tmp/probe'
check "/workspace is writable"           run 'touch /workspace/probe'
check "locale is UTF-8"                  run '[ "$(locale charmap 2>/dev/null)" = "UTF-8" ]'
check "tini is present to reap orphans"  run '[ -x /usr/bin/tini ]'
check "git is installed"                 run 'git --version'
# Run this in /tmp, where the process owns what it creates, so the assertion is
# about the passwd entry rather than about bind-mount ownership.
check "git does not warn about the current user" \
    run 'cd /tmp && git init -q r && ! git -C r status 2>&1 | grep -q "unable to look up"'

if has_cli; then
    echo "== runtime =="
    check "coding-runtime is on PATH"    run 'command -v coding-runtime'
    check "reports a version"            run 'coding-runtime version | grep -Eq "^[0-9]+\\.[0-9]+\\.[0-9]+"'
    check "an unknown command explains itself" run 'coding-runtime nope 2>&1 | grep -q usage'
    check "tmux is present"              run 'tmux -V'
    check "gh is present"                run 'gh --version'
    check "glab is present"              run 'glab --version'
    check "node-pty loads"               run 'node -e "require(\"/opt/coding-runtime/node_modules/node-pty\")"'
else
    echo "== runtime (thin: no Node, contract only) =="
    check "python is present"            run 'python3 --version'
    check "uv is present"                run 'uv --version'
    check "a version is recorded"        run '[ -s /opt/coding-runtime/VERSION ]'
fi

if [ "$MODE" = base ]; then
    if has_cli; then
        # A base image ships no manifest — an adapter supplies it — so doctor is
        # expected to report that. Capture the output first and assert against
        # it, rather than piping into `grep -q`: grep is silent by design, so a
        # failure there tells you nothing about what doctor actually said.
        doctor_out="$(run 'coding-runtime doctor' 2>&1 || true)"
        echo "  --- coding-runtime doctor ---"
        printf '%s\n' "$doctor_out" | sed 's/^/        | /'
        # shellcheck disable=SC2317  # invoked indirectly, via check
        doctor_names_manifest() { printf '%s' "$doctor_out" | grep -q 'runtime.json'; }
        check "doctor explains a missing manifest" doctor_names_manifest

        # The base ships no manifest, so the entrypoint must refuse to start and
        # say why. An entrypoint that exits 0 having done nothing is the failure
        # mode this guards: it looks healthy from every angle except the agent
        # never actually running.
        entry_out="$(run_entrypoint || true)"
        echo "  --- entrypoint ---"
        printf '%s\n' "$entry_out" | sed 's/^/        | /' | tail -6
        # shellcheck disable=SC2317  # invoked indirectly, via check
        entry_explains() { printf '%s' "$entry_out" | grep -q 'runtime.json'; }
        check "the entrypoint fails loudly without a manifest" entry_explains
    fi
    echo
    echo "base image: $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]
    exit
fi

echo "== adapter =="
check "doctor passes"               run 'coding-runtime doctor'
check "seed writes harness config"  run 'coding-runtime seed && [ -n "$(ls -A /workspace)" ]'
check "seed is idempotent"          run 'coding-runtime seed && coding-runtime seed 2>&1 | grep -q unchanged'
# Timestamped against a marker written at container start rather than against
# a file baked into the image: every file an adapter layer adds is newer than
# the base's own VERSION, so that reference flagged the adapter's manifest as if
# seed had written it. What matters is what seed changes at runtime.
check "seed writes nothing outside /tmp and /workspace" \
    run 'touch /tmp/.mark
         coding-runtime seed >/dev/null 2>&1
         found=$(find / -xdev -newer /tmp/.mark -type f \
             -not -path "/tmp/*" -not -path "/workspace/*" \
             -not -path "/proc/*" -not -path "/sys/*" 2>/dev/null | head -5)
         [ -z "$found" ] || { echo "seed wrote outside the writable paths:"; echo "$found"; exit 1; }'

SURFACE="$(docker run --rm --entrypoint sh "$IMAGE" -c 'cat /etc/coding-runtime/runtime.json 2>/dev/null' \
    | tr -d ' \n' | grep -o '"surface":"[a-z]*"' | cut -d'"' -f4 || true)"

if [ "$SURFACE" = terminal ]; then
    echo "== serving surface =="
    docker run -d --name "$CONTAINER" \
        --read-only --tmpfs /tmp:rw,size=64m \
        --user 1000:1000 --cap-drop ALL \
        -v "$WORKDIR/workspace:/workspace" -v "$WORKDIR/etc-agent:/etc/agent:ro" \
        -e AGENT_NAME=conformance -e PORT=8080 -p 18080:8080 "$IMAGE" >/dev/null

    for _ in $(seq 1 60); do
        curl -fsS http://127.0.0.1:18080/healthz >/dev/null 2>&1 && break
        sleep 0.5
    done

    check "/healthz answers"      curl -fsS http://127.0.0.1:18080/healthz
    check "/readyz answers"       curl -fsS http://127.0.0.1:18080/readyz
    check "/runtime.json answers" curl -fsS http://127.0.0.1:18080/runtime.json
    check "the manifest is redacted by default" \
        sh -c '! curl -fsS http://127.0.0.1:18080/runtime.json | grep -q launch'
    check "the terminal page serves xterm" \
        sh -c 'curl -fsS http://127.0.0.1:18080/ | grep -q xterm.js'
    # oauth2-proxy would answer these itself before the upstream saw them, so a
    # runtime must not depend on them.
    check "/ping and /ready are not used as probes" \
        sh -c '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18080/ping)" = 404 ]'

    # The cross-origin guard: a page on another origin must not be able to open
    # the terminal, even though the proxy in front would authorise the request.
    ws_status() {
        curl -sS -o /dev/null -w '%{http_code}' \
            -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
            -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
            -H "Origin: $1" http://127.0.0.1:18080/ws
    }
    # Passed as a function rather than through `sh -c`, which would spawn a
    # shell that has never seen ws_status.
    ws_is() { [ "$(ws_status "$2")" = "$1" ]; }
    check "same-origin upgrade is accepted"  ws_is 101 http://127.0.0.1:18080
    check "cross-origin upgrade is rejected" ws_is 403 https://evil.example

    # A 101 only proves the handshake. These two together prove the rest of the
    # path, and do it for any terminal program rather than only for a shell.
    #
    # The probe runs inside the image sharing the server's network namespace, so
    # it uses the base's own ws and reaches the terminal on loopback exactly as
    # the oauth2-proxy sidecar would. It types plain text and never presses
    # Enter: submitting a line means something different — and possibly
    # destructive — in every terminal program.
    MARKER="zqjxConformanceProbe"
    terminal_carries_traffic() {
        docker run --rm --network "container:$CONTAINER" \
            --entrypoint node "$IMAGE" \
            /opt/coding-runtime/test/ws-probe.cjs \
            ws://127.0.0.1:8080/ws http://127.0.0.1:8080 "$MARKER"
    }
    check "the terminal socket carries traffic both ways" terminal_carries_traffic

    # Whether those keystrokes actually reached the program is a question for
    # tmux, not for the socket. capture-pane renders the pane as plain text, so
    # this holds for a shell showing a command line and for a TUI showing its
    # prompt box alike — and it runs after the probe has disconnected, so it
    # also demonstrates the session outliving the browser that opened it.
    keystrokes_reached_the_program() {
        session="$(docker exec "$CONTAINER" tmux list-sessions -F '#{session_name}' 2>/dev/null | head -1)"
        [ -n "$session" ] || { echo "no tmux session exists"; return 1; }
        for _ in $(seq 1 30); do
            pane="$(docker exec "$CONTAINER" tmux capture-pane -p -t "$session" 2>/dev/null | tr -d '[:space:]')"
            case "$pane" in *"$MARKER"*) return 0 ;; esac
            sleep 1
        done
        echo "typed text never appeared in the tmux pane; last capture:"
        docker exec "$CONTAINER" tmux capture-pane -p -t "$session" 2>&1 | tail -8
        return 1
    }
    check "a keystroke reaches the program under tmux" keystrokes_reached_the_program

    docker logs "$CONTAINER" 2>&1 | tail -20
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
