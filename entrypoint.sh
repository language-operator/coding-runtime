#!/bin/sh
# coding-runtime container entrypoint.
#
# Three steps, in order:
#
#   1. Resolve the environment. HOME, the XDG directories and every cache path
#      have to be computed at runtime rather than baked, because the agent
#      container runs with a read-only root filesystem and the only writable
#      paths are /tmp and the workspace PVC.
#   2. Seed config. This runs here, in the agent container, rather than in an
#      init container: the operator mounts /tmp only into the agent container,
#      so an init container has no writable path it could hand anything through.
#      The normalized config is a pure function of /etc/agent/config.yaml and
#      the environment, both of which are available right here.
#   3. Serve. `exec` so the serving process replaces this shell and receives
#      SIGTERM directly when the Workflow is replaced.
set -eu

eval "$(coding-runtime env)"

if [ "${CODING_RUNTIME_SKIP_SEED:-}" != "1" ]; then
    coding-runtime seed
fi

exec coding-runtime serve
