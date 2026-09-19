REGISTRY ?= ghcr.io/language-operator
IMAGE    ?= $(REGISTRY)/coding-runtime
VERSION  ?= $(shell node -p "require('./package.json').version")
TAG      ?= $(VERSION)

.PHONY: help test lint build build-thin conformance goldens

help:
	@echo "test         run the unit suite (no container needed)"
	@echo "lint         shellcheck the shell entrypoints"
	@echo "build        build the thick image as $(IMAGE):$(TAG)"
	@echo "build-thin   build the thin image as $(IMAGE):$(TAG)-python"
	@echo "conformance  run the in-image conformance suite against a built image"
	@echo "goldens      regenerate the golden fixtures"

test:
	npm test

lint:
	shellcheck entrypoint.sh test/conformance.sh

build:
	docker build --target thick --build-arg VERSION=$(VERSION) -t $(IMAGE):$(TAG) -t $(IMAGE):latest .

build-thin:
	docker build --target thin --build-arg VERSION=$(VERSION) -t $(IMAGE):$(TAG)-python -t $(IMAGE):latest-python .

conformance: build
	test/conformance.sh $(IMAGE):$(TAG) base

goldens:
	UPDATE_GOLDENS=1 npm test
