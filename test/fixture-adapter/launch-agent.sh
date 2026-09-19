#!/bin/sh
# Stand-in for a real harness CLI.
#
# The fixture adapter exists to exercise the serving path — tmux, the pty, the
# WebSocket bridge and the origin guard — without pulling a multi-hundred-
# megabyte agent CLI into CI. What the terminal runs does not matter, only that
# it is a live interactive process attached to a tty, so a plain shell is the
# most honest stand-in there is.
set -eu

echo "coding-runtime fixture adapter — $(coding-runtime version)"
exec bash --norc --noprofile -i
