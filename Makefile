# Makefile for spore-host infrastructure
#
# The CLI tools (truffle, spawn, lagotto, spore-host-mcp) live in their own repos:
#   https://github.com/spore-host/truffle
#   https://github.com/spore-host/spawn
#   https://github.com/spore-host/lagotto
#   https://github.com/spore-host/spore-host-mcp
#
# This repo holds infrastructure: the rest-api Lambda, dashboard (web/),
# Python SDK (sdk/), deployment scripts (scripts/), AMIs (infra/), and docs.

.PHONY: build-rest-api test-rest-api docs-dev docs-build security clean help portal-check portal-gates portal-iam-update portal-e2e-aws portal-e2e-aws-sweep

# Build the hosted REST API Lambda
build-rest-api:
	@echo "Building rest-api Lambda..."
	@cd lambda/rest-api && GOOS=linux GOARCH=arm64 go build -o bootstrap .
	@echo "✅ lambda/rest-api/bootstrap"

# Test the rest-api Lambda
test-rest-api:
	@cd lambda/rest-api && go test ./...

# Run the VitePress docs site locally
docs-dev:
	@cd docs && npm run dev

# Build the VitePress docs site
docs-build:
	@cd docs && npm run build

# Security scans (govulncheck on the Lambda, trivy on infra)
security:
	@cd lambda/rest-api && go vet ./... && govulncheck ./... || true

# The rebuilt portal (web/portal/, #683). Not deployed; see web/portal/vite.config.ts.
# portal-check: typecheck + unit tests + offline gates (contrast, tokens, copy,
# CLI⇄GUI matrix, IAM inventory and fixtures). No browser, no AWS.
portal-check:
	@cd web && npm run portal:typecheck && npm run portal:test

# portal-gates: portal-check plus the Playwright gates (axe, keyboard, 320 px,
# rendered copy, rendered matrix, self-test). Needs `npx playwright install chromium` once.
portal-gates:
	@cd web && npm run portal:gates

# portal-e2e-aws: the REAL-AWS e2e harness (web/portal/e2e-aws/). Launches two
# t4g.nano On-Demand instances in the dev account with a 15m TTL, proves the
# tag-gated grants, tears down and leak-checks, then sweeps the run whatever
# happened. Needs credentials for 435415984226 that may assume
# spore-portal-e2e, e.g. AWS_PROFILE=spore-host-dev. Costs well under a cent.
portal-e2e-aws:
	@cd web && run_id="$${PORTAL_E2E_RUN_ID:-local-$$(date -u +%Y%m%dt%H%M%Sz)-$$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')}"; \
	  echo "portal e2e run id: $$run_id"; \
	  PORTAL_E2E_RUN_ID="$$run_id" PORTAL_E2E_AWS=1 npm run portal:e2e-aws; status=$$?; \
	  PORTAL_E2E_RUN_ID="$$run_id" PORTAL_E2E_SWEEP=1 npm run portal:e2e-aws:sweep || status=1; \
	  exit $$status

# portal-e2e-aws-sweep: terminate and leak-check one e2e run by id, e.g. after a
# killed run: PORTAL_E2E_RUN_ID=<id> make portal-e2e-aws-sweep
portal-e2e-aws-sweep:
	@test -n "$(PORTAL_E2E_RUN_ID)" || { echo "set PORTAL_E2E_RUN_ID=<run id>"; exit 2; }
	@cd web && PORTAL_E2E_SWEEP=1 npm run portal:e2e-aws:sweep

# Regenerate web/portal/iam/inventory.json after adding or removing an AWS call.
portal-iam-update:
	@cd web && npm run portal:iam:update

clean:
	@rm -f lambda/rest-api/bootstrap lambda/rest-api/*.zip
	@rm -rf web/.portal-build

help:
	@echo "spore-host infrastructure targets:"
	@echo "  build-rest-api  Build the hosted REST API Lambda"
	@echo "  test-rest-api   Test the rest-api Lambda"
	@echo "  docs-dev        Run the VitePress docs site locally"
	@echo "  docs-build      Build the VitePress docs site"
	@echo "  security        Run security scans"
	@echo "  portal-check    Portal typecheck, unit tests and offline gates"
	@echo "  portal-gates    portal-check plus the Playwright accessibility/keyboard/reflow gates"
	@echo "  portal-iam-update  Regenerate the portal's IAM inventory"
	@echo "  portal-e2e-aws  Portal real-AWS e2e + leak check (AWS_PROFILE=spore-host-dev; launches 2 t4g.nano)"
	@echo "  portal-e2e-aws-sweep  Terminate + leak-check one e2e run (PORTAL_E2E_RUN_ID=<id>)"
	@echo "  clean           Remove build artifacts"
