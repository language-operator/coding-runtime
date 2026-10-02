# A minimal adapter built on the base, used only by the conformance suite.
#
# It builds from `examples/minimal/`, so CI proves the documented starting point
# for an adapter actually works rather than that some arrangement invented here
# does. The example is not a copy of any shipped adapter: a real adapter's output
# shape is its own business, tested in its own repository against the base digest
# it pins.
#
# Build from the repository root. Use the default (docker-driver) builder, so
# a locally built base image is visible:
#   docker buildx build --builder default --load \
#     -f test/fixture-adapter/Dockerfile --build-arg BASE=<image> -t <tag> .
ARG BASE=coding-runtime:thick
FROM ${BASE}

USER root
COPY examples/minimal/runtime.json /etc/coding-runtime/runtime.json
COPY examples/minimal/emit.mjs /opt/adapter/emit.mjs
COPY --chmod=755 test/fixture-adapter/launch-agent.sh /usr/local/bin/launch-agent
USER node
