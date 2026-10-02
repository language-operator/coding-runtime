#!/usr/bin/env bash
# Conformance suite for a coding-runtime image, or any adapter image built on one.
#
#     test/conformance.sh <image> [base|adapter]
#
# CONFORMANCE_SKIP declares checks an image cannot pass, one exact description
# per line. A declared check still runs: it is reported as `skip` when it fails,
# but as a failure when it passes, so a skip cannot outlive the limitation that
# justified it. Adapters needed a wrapper script to get this, which meant every
# repo reimplemented the accounting and could drift from the suite's own names.
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
SKIP=0
# Descriptions from CONFORMANCE_SKIP that a check actually presented this run.
# Without this, a declaration that no longer matches anything is a silent no-op:
# the suite already renamed this very check once, and adapters re-extract the
# script from each new base, so a stale declaration is the expected failure.
SKIP_SEEN=""

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

# Exact-match, so a declared skip names one check and cannot widen silently into
# a prefix that swallows checks added later.
declared_skip() {
    [ -n "${CONFORMANCE_SKIP:-}" ] || return 1
    # A here-string rather than `printf | grep`: one process instead of two, and
    # no pipeline whose writer's status can mask the match under pipefail.
    grep -qxF "$1" <<<"$CONFORMANCE_SKIP"
}

# Fails for any declaration that matched no check this run — the other half of
# "a skip cannot outlive its justification". Named for both modes, since a
# mode-specific check does not run in the other one.
audit_declared_skips() {
    [ -n "${CONFORMANCE_SKIP:-}" ] || return 0
    local line
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        if ! grep -qxF "$line" <<<"$SKIP_SEEN"; then
            echo "  FAIL  CONFORMANCE_SKIP declares a check that did not run"
            echo "          | $line"
            echo "          | renamed, removed, or not part of this mode"
            FAIL=$((FAIL + 1))
        fi
    done <<<"$CONFORMANCE_SKIP"
}

check() {
    local desc="$1"; shift
    local out
    if declared_skip "$desc"; then
        SKIP_SEEN="${SKIP_SEEN}${desc}
"
    fi
    # Captured rather than discarded: a failing check in CI is useless without
    # the reason, and the container is gone by the time anyone looks.
    if out="$("$@" 2>&1)"; then
        if declared_skip "$desc"; then
            # Declared inapplicable, yet it passes. Reported as a failure on
            # purpose: the alternative is a skip nobody ever removes, which is
            # how a tolerance ends up citing a limitation that no longer exists.
            echo "  FAIL  $desc"
            echo "          | this check passes — remove it from CONFORMANCE_SKIP"
            FAIL=$((FAIL + 1))
            return
        fi
        echo "  ok    $desc"
        PASS=$((PASS + 1))
        return
    fi
    if declared_skip "$desc"; then
        echo "  skip  $desc"
        if [ -n "$out" ]; then
            # head, not tail: the first lines carry the reason, and for the
            # terminal check the tail is unlabelled pane content.
            printf '%s\n' "$out" | sed 's/^/          | /' | head -4
        fi
        SKIP=$((SKIP + 1))
        return
    fi
    echo "  FAIL  $desc"
    if [ -n "$out" ]; then
        printf '%s\n' "$out" | sed 's/^/          | /' | tail -12
    else
        echo "          | (no output)"
    fi
    FAIL=$((FAIL + 1))
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
# Both variants, not just thin: python3 and uv are part of what every adapter can
# assume. uv is checked by running it, because it arrives as a copied binary and a
# wrong-architecture copy is the failure that would otherwise surface as a crash
# in someone's agent.
check "python3 is present"               run 'python3 --version'
check "uv is present"                    run 'uv --version'
check "uvx is present"                   run 'uvx --version'
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
    check "gh is present"                run 'gh --version'
    check "glab is present"              run 'glab --version'
    check "a version is recorded"        run '[ -s /opt/coding-runtime/VERSION ]'
fi

if has_cli; then
    echo "== execution mode =="

    # Written into the workspace and pointed at with CODING_RUNTIME_MANIFEST, so
    # these checks need no change to examples/ and work against the base image
    # and a real adapter alike.
    task_manifest() {
        cat > "$WORKDIR/workspace/$1" <<JSON
{
  "schemaVersion": 1,
  "name": "conformance-task",
  "serve": { "surface": "terminal", "port": 8080 },
  "terminal": { "launch": ["sh", "-c", "sleep 3600"] }${2:+,}
  ${2:-}
}
JSON
    }

    run_mode() {
        docker run --rm \
            --read-only --tmpfs /tmp:rw,size=64m \
            --user 1000:1000 --cap-drop ALL \
            -v "$WORKDIR/workspace:/workspace" \
            -v "$WORKDIR/etc-agent:/etc/agent:ro" \
            -e AGENT_NAME=conformance -e HOME=/workspace/.home \
            -e AGENT_EXECUTION_MODE="$1" \
            -e CODING_RUNTIME_MANIFEST="/workspace/$2" \
            "$IMAGE" 2>&1
    }

    exits_with() {
        local want="$1" mode="$2" file="$3" out status=0
        out="$(run_mode "$mode" "$file")" || status=$?
        [ "$status" = "$want" ] && return 0
        printf '%s\n' "wanted exit $want, got $status" "$out"
        return 1
    }

    # The task command's own success depends on reaching /healthz, so exit 0
    # proves both that the run ended and that the server answered while it was
    # working. That second half is not incidental: the pod's probes are not
    # gated on execution mode, and both terminal runtimes aim a startupProbe at
    # /healthz with failureThreshold 30 at 2s — so a task run with nothing
    # listening is killed about 65 seconds in, mid-work.
    task_manifest task-probe.json '"task": { "exec": ["sh", "-c", "curl -fsS http://127.0.0.1:${PORT}/healthz"] }'
    check "a task run exits, and /healthz answers while it runs" \
        exits_with 0 task task-probe.json

    # The exit code is the run's phase, so it has to survive unchanged.
    task_manifest task-exit3.json '"task": { "exec": ["sh", "-c", "exit 3"] }'
    check "a task run's exit code reaches the caller" \
        exits_with 3 task task-exit3.json

    # An adapter that has not adopted task mode must fail legibly rather than
    # hang: a Running workflow that never ends is the defect this replaced.
    task_manifest task-none.json
    names_task_exec() {
        local out status=0
        out="$(run_mode task task-none.json)" || status=$?
        [ "$status" != 0 ] && printf '%s' "$out" | grep -q 'task\.exec' && return 0
        printf '%s\n' "status=$status (wanted non-zero, output naming task.exec)" "$out"
        return 1
    }
    check "task mode without a task command fails loudly" names_task_exec

    # The inverse regression, and the worse one: a service agent that exits is
    # every long-running agent dying at boot. `timeout` killing it is the pass.
    stays_up_in_service_mode() {
        local status=0
        timeout 12 docker run --rm \
            --read-only --tmpfs /tmp:rw,size=64m \
            --user 1000:1000 --cap-drop ALL \
            -v "$WORKDIR/workspace:/workspace" \
            -v "$WORKDIR/etc-agent:/etc/agent:ro" \
            -e AGENT_NAME=conformance -e HOME=/workspace/.home \
            -e AGENT_EXECUTION_MODE=service \
            -e CODING_RUNTIME_MANIFEST=/workspace/task-probe.json \
            "$IMAGE" >/dev/null 2>&1 || status=$?
        # 124 is `timeout` reaping a process that was still running.
        [ "$status" = 124 ] && return 0
        echo "service mode exited on its own with $status"
        return 1
    }
    check "service mode keeps running even with a task command declared" \
        stays_up_in_service_mode
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
    audit_declared_skips
    if [ "$SKIP" -gt 0 ]; then
        echo "base image: $PASS passed, $FAIL failed, $SKIP skipped by CONFORMANCE_SKIP"
    else
        echo "base image: $PASS passed, $FAIL failed"
    fi
    [ "$FAIL" -eq 0 ]
    exit
fi

echo "== adapter =="
# Both bases already provide exactly one user at uid 1000. An adapter that adds
# its own gives getpwuid() two answers, and which one wins depends on file order.
check "uid 1000 has exactly one passwd entry" \
    run 'users=$(getent passwd | awk -F: "\$3 == 1000")
         [ "$(printf "%s\n" "$users" | wc -l)" = 1 ] || { echo "$users"; exit 1; }'
# An adapter that replaces ENTRYPOINT loses tini, and nothing reaps orphans.
# Inspected rather than observed: the thin base's entrypoint runs the adapter's
# CMD, which may need credentials or a network this suite cannot provide.
entrypoint_is_tini() {
    local entrypoint
    entrypoint="$(docker image inspect --format '{{json .Config.Entrypoint}}' "$IMAGE")"
    case "$entrypoint" in
        '["/usr/bin/tini"'*) ;;
        *) echo "entrypoint is $entrypoint"; return 1 ;;
    esac
}
check "the entrypoint still runs under tini" entrypoint_is_tini

# A thin adapter has no Node CLI: it reads /etc/agent/config.yaml itself, and
# has no doctor or seed for this suite to exercise.
if has_cli; then
    check "doctor passes"               run 'coding-runtime doctor'
    check "seed writes harness config"  run 'coding-runtime seed && [ -n "$(ls -A /workspace)" ]'
    check "seed is idempotent"          run 'coding-runtime seed && coding-runtime seed 2>&1 | grep -q unchanged'
    # Timestamped against a marker written at container start rather than
    # against a file baked into the image: every file an adapter layer adds is
    # newer than the base's own VERSION, so that reference flagged the adapter's
    # manifest as if seed had written it. What matters is what seed changes at
    # runtime.
    check "seed writes nothing outside /tmp and /workspace" \
        run 'touch /tmp/.mark
             coding-runtime seed >/dev/null 2>&1
             found=$(find / -xdev -newer /tmp/.mark -type f \
                 -not -path "/tmp/*" -not -path "/workspace/*" \
                 -not -path "/proc/*" -not -path "/sys/*" 2>/dev/null | head -5)
             [ -z "$found" ] || { echo "seed wrote outside the writable paths:"; echo "$found"; exit 1; }'
fi

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
audit_declared_skips
if [ "$SKIP" -gt 0 ]; then
    echo "$PASS passed, $FAIL failed, $SKIP skipped by CONFORMANCE_SKIP"
else
    echo "$PASS passed, $FAIL failed"
fi
[ "$FAIL" -eq 0 ]
