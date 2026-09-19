# A minimal adapter built on the base, used only by the conformance suite.
#
# It deliberately reuses the *shipped* example manifest and emitter rather than
# fixtures of its own, so CI proves the documented way to build an adapter
# actually works, not merely that some contrived arrangement does.
#
# Build from the repository root. Use the default (docker-driver) builder, so
# a locally built base image is visible:
#   docker buildx build --builder default --load \
#     -f test/fixture-adapter/Dockerfile --build-arg BASE=<image> -t <tag> .
ARG BASE=coding-runtime:thick
FROM ${BASE}

USER root
COPY examples/claude-code/runtime.json /etc/coding-runtime/runtime.json
COPY examples/claude-code/emit.mjs /opt/adapter/emit.mjs
COPY --chmod=755 test/fixture-adapter/launch-agent.sh /usr/local/bin/launch-claude
USER node
