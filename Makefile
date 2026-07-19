.DEFAULT_GOAL := help
.PHONY: help install lint format test coverage version build

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

lint: ## Check linting and formatting
	npx biome check .

format: ## Apply formatting and safe lint fixes
	npx biome check --write .

test: ## Run the test suite
	npx vitest run

coverage: ## Run the test suite with the 100% coverage gate
	npx vitest run --coverage

version: ## Set the release version, e.g. make version v=1.2.3
	@echo "$(v)" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$$' || { echo "usage: make version v=X.Y.Z"; exit 1; }
	@npm version "$(v)" --no-git-tag-version --allow-same-version >/dev/null
	@echo "version set to $(v)"

build: ## Build the publishable tarball (npm pack)
	npm pack
