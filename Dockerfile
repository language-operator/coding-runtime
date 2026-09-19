# syntax=docker/dockerfile:1
#
# coding-runtime — the base image for language-operator harness adapters.
#
# Two variants, split by the shape of the agent rather than by which harness it
# wraps:
#
#   thick  an interactive terminal coding agent. Node, the full unix toolchain,
#          gh/glab, Go, Helm, tmux and the web terminal. Used by claude-code,
#          opencode and openclaw.
#   thin   a headless HTTP agent whose own process is the agent. Python and uv,
#          the same runtime posture, no Node and no serving surface. Used by
#          deepagents.
#
# They have different parents and therefore share no layers. That is deliberate
# and costs nothing: no node runs both shapes expecting deduplication. What they
# share is the contract — the normalized config schema, the fixture corpus, and
# the uid/HOME/cache posture below — not bytes.

ARG GH_VERSION=2.65.0
ARG GLAB_VERSION=1.117.0
ARG GO_VERSION=1.26.4
ARG HELM_VERSION=3.17.3

# =============================================================================
# deps — compile native modules once, here, so no adapter ever needs a compiler.
#
# node-pty ships no Linux prebuilds. Today claude-code-adapter and
# opencode-adapter each carry a g++/make/python3 build stage purely to build it.
# Compiling in the base deletes that from every adapter.
#
# Multi-arch note: node-pty builds per-architecture. Under buildx each platform
# gets its own builder, so node_modules must never be copied across architectures.
# =============================================================================
FROM node:24-slim AS deps
WORKDIR /opt/coding-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# =============================================================================
# tools — the CLIs Debian does not package at a useful version.
#
# Built once and copied into both variants, so a version bump happens in exactly
# one place and the layer is shared.
# =============================================================================
FROM debian:trixie-slim AS tools
ARG GH_VERSION
ARG GLAB_VERSION
ARG GO_VERSION
ARG HELM_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tar wget \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /out

# gh: GitHub CLI. The operator exports GH_TOKEN for agents on GitHub
# repositories, so gh is authenticated with no setup of its own.
RUN ARCH=$(dpkg --print-architecture) && \
    wget -qO /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" && \
    tar -xzf /tmp/gh.tar.gz -C /tmp && \
    install -D "/tmp/gh_${GH_VERSION}_linux_${ARCH}/bin/gh" /out/usr/local/bin/gh

# glab: GitLab CLI. Same arrangement via GITLAB_TOKEN.
RUN ARCH=$(dpkg --print-architecture) && \
    wget -qO /tmp/glab.tar.gz "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${ARCH}.tar.gz" && \
    tar -xzf /tmp/glab.tar.gz -C /tmp bin/glab && \
    install -D /tmp/bin/glab /out/usr/local/bin/glab

# Helm, for agents that work on charts.
RUN ARCH=$(dpkg --print-architecture) && \
    wget -qO /tmp/helm.tar.gz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${ARCH}.tar.gz" && \
    tar -xzf /tmp/helm.tar.gz -C /tmp && \
    install -D "/tmp/linux-${ARCH}/helm" /out/usr/local/bin/helm

# Go, from the upstream tarball — Debian's package lags releases badly.
RUN ARCH=$(dpkg --print-architecture) && \
    wget -qO /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" && \
    mkdir -p /out/usr/local && tar -xzf /tmp/go.tar.gz -C /out/usr/local

# =============================================================================
# thick
# =============================================================================
FROM node:24-slim AS thick

# UTF-8 everywhere. node:24-slim ships C.UTF-8; it just has to be selected.
# Without this the locale is POSIX, and tmux and every TUI fall back to ASCII —
# no box drawing, no glyphs.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        diffutils \
        gawk \
        git \
        htop \
        jq \
        less \
        make \
        openssh-client \
        procps \
        ripgrep \
        shellcheck \
        tini \
        tmux \
        tree \
        unzip \
        vim \
        wget \
    && rm -rf /var/lib/apt/lists/*

COPY --from=tools /out/usr/local/ /usr/local/
ENV PATH=/usr/local/go/bin:$PATH

# The runtime itself. Everything lives under /opt, root-owned and never written
# at runtime — the agent container's root filesystem is read-only.
WORKDIR /opt/coding-runtime
COPY --from=deps /opt/coding-runtime/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
# The image carries its own conformance suite. An adapter extracts it from the
# base it was built on, which guarantees the checks match the runtime being
# checked — and, unlike fetching the script alone, brings the probe it needs:
#   docker run --rm --entrypoint cat <image> \
#     /opt/coding-runtime/test/conformance.sh > conformance.sh
COPY --chmod=755 test/conformance.sh ./test/conformance.sh
COPY test/ws-probe.cjs ./test/ws-probe.cjs
COPY etc/tmux.conf /etc/tmux.conf
COPY --chmod=755 entrypoint.sh /entrypoint.sh
# A wrapper rather than a symlink: through a symlink, argv[1] is the link path
# while import.meta.url is the resolved target, and anything comparing the two
# sees them differ.
RUN printf '#!/bin/sh\nexec node /opt/coding-runtime/src/cli.mjs "$@"\n' > /usr/local/bin/coding-runtime \
    && chmod 755 /usr/local/bin/coding-runtime /opt/coding-runtime/src/cli.mjs

ARG VERSION=0.0.0-dev
RUN echo "$VERSION" > /opt/coding-runtime/VERSION

# Where an adapter drops its emitter and launcher.
RUN mkdir -p /opt/adapter /etc/coding-runtime

# The workspace PVC mounts over this; it exists so `docker run` without a volume
# still has a writable working directory.
RUN mkdir -p /workspace && chown node:node /workspace

# The operator pins the agent container to uid 1000 unconditionally
# (buildContainerSecurityContext is applied with no override path). node:24-slim
# already has `node` at uid 1000 with a passwd entry and /bin/bash as its shell,
# which is exactly what is needed — creating a second user at the same uid would
# only risk getting it wrong. Adapters must not change this.
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
    CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" >/dev/null 2>&1 || exit 1

# tini reaps orphans and forwards signals. tmux daemonizes, so its server
# reparents onto PID 1; Node does not reap arbitrary orphans, and zombies would
# accumulate across reconnects. It is masked today only because the operator
# happens to set shareProcessNamespace whenever there are init containers.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/entrypoint.sh"]

# =============================================================================
# thin
# =============================================================================
FROM python:3.13-slim AS thin

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.16 /uv /uvx /usr/local/bin/

# python:3.13-slim has no uid 1000. Without a passwd entry for the uid the
# operator forces, git warns on every command, ssh complains, and anything
# calling getpwuid() to find a home directory fails outright.
RUN groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid 1000 --shell /bin/bash --create-home agent

COPY --chmod=755 test/conformance.sh /opt/coding-runtime/test/conformance.sh

# What thin provides today is the runtime posture: uid 1000 with a passwd entry,
# tini, uv, git, and the cache/HOME layout resolved against a read-only rootfs.
# The Python port of the config normalizer lands with the deepagents migration,
# where it can be validated against that adapter's existing test suite; until
# then a thin adapter reads /etc/agent/config.yaml itself, and the normalized
# schema plus the shared fixture corpus in test/fixtures are the contract it
# should be written against.

ARG VERSION=0.0.0-dev
RUN mkdir -p /opt/coding-runtime /opt/adapter /etc/coding-runtime \
    && echo "$VERSION" > /opt/coding-runtime/VERSION \
    && mkdir -p /workspace && chown agent:agent /workspace

USER agent
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
