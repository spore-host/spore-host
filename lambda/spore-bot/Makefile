.PHONY: build clean test deploy upload update-code verify check-account

# How spore-bot is deployed (#570):
#
#   - The function's SHAPE (role, runtime, arch, memory, timeout, Function URL)
#     is OpenTofu-managed: infra/tofu/spore-bot. Change it there.
#   - The function's CODE is shipped from here: `make deploy` builds, uploads to
#     S3, points the function at the new object, waits, and verifies.
#   - Environment variables (secrets) are set out-of-band with
#     `aws lambda update-function-configuration`; neither Tofu nor this Makefile
#     touches them.
#
# There is no CloudFormation stack. `deploy` used to end in `stack-deploy`, which
# ran `aws cloudformation deploy` against deployment/cloudformation/spore-bot.yaml
# — a file that does not exist in this repo. So `make deploy` uploaded the zip,
# then failed, and the function code was never updated. The `spore-bot` stack was
# deleted on 2026-06-14 when Tofu adopted the function; re-creating it would fight
# Tofu for ownership. scripts/check-deploy-paths.sh now fails CI if `deploy`
# references a file that does not exist.
#
# The cross-account role customers deploy (SpawnBotCrossAccount) is not managed
# here either: `spawn bot register` creates it, and its CloudFormation template
# lives in the spawn repo (deployment/cloudformation/bot-cross-account-role.yaml).

# bash, not /bin/sh: the verify step needs pipefail (dash has none), so a failing
# openssl on the left of a pipe can't produce an empty hash that "matches".
SHELL := /bin/bash

# Configurable — override with environment variables or on the command line.
S3_BUCKET        ?= spawn-binaries-us-east-1
S3_KEY           ?= spore-bot/function.zip
FUNCTION_NAME    ?= spore-bot
REGION           ?= us-east-1
# Named DEPLOY_PROFILE, not AWS_PROFILE: `?=` yields to the environment, so an
# ambient AWS_PROFILE (set for some other account) would silently win over the infra
# profile. check-account would then fail the deploy, but this keeps the default
# meaning "the infra account" regardless of the caller's shell.
DEPLOY_PROFILE   ?= spore-host-infra
# The account the function lives in. Asserted, not inferred from whatever
# credentials are ambient. Override only to deploy a self-hosted copy.
EXPECTED_ACCOUNT ?= 966362334030

# What is being deployed, for the log line. `git describe` says -dirty out loud
# when the tree has uncommitted changes. Capture first, then default: a pipeline's
# status is the last command's, so `... | sed || echo unknown` never fires.
VERSION ?= $(shell v=$$(git describe --tags --always --dirty 2>/dev/null); printf '%s' "$${v:-unknown}")

AWS := AWS_PROFILE=$(DEPLOY_PROFILE) aws --region $(REGION)

## build: Compile Lambda binary and zip for deployment
build:
	@echo "Building spore-bot Lambda (linux/arm64)..."
	GOOS=linux GOARCH=arm64 go build -tags lambda.norpc -o bootstrap .
	@# rm first: `zip` UPDATES an existing archive rather than replacing it.
	rm -f function.zip
	zip function.zip bootstrap
	@echo "Build complete: function.zip"

## clean: Remove build artifacts
clean:
	rm -f bootstrap function.zip

## test: Run unit tests
test:
	go test . -v

## check-account: Fail unless the credentials are for EXPECTED_ACCOUNT
check-account:
	@set -euo pipefail; \
	acct=$$($(AWS) sts get-caller-identity --query Account --output text); \
	if [ "$$acct" != "$(EXPECTED_ACCOUNT)" ]; then \
		echo "ERROR: DEPLOY_PROFILE=$(DEPLOY_PROFILE) is account $$acct, expected $(EXPECTED_ACCOUNT)." >&2; \
		echo "       Set DEPLOY_PROFILE, or EXPECTED_ACCOUNT=$$acct to deploy there deliberately." >&2; \
		exit 1; \
	fi; \
	echo "Account $$acct (profile $(DEPLOY_PROFILE)), region $(REGION)"

## upload: Build and upload zip to S3
upload: check-account build
	@echo "Uploading to s3://$(S3_BUCKET)/$(S3_KEY)..."
	$(AWS) s3 cp function.zip s3://$(S3_BUCKET)/$(S3_KEY)
	@echo "Upload complete"

## update-code: Point the function at the uploaded zip and wait for it to apply
update-code: check-account
	$(AWS) lambda update-function-code \
		--function-name $(FUNCTION_NAME) \
		--s3-bucket $(S3_BUCKET) \
		--s3-key $(S3_KEY) \
		--no-cli-pager >/dev/null
	$(AWS) lambda wait function-updated --function-name $(FUNCTION_NAME)

## verify: Fail unless the live function runs exactly the local function.zip
# An accepted update-function-code is not evidence the function runs the new
# binary. CodeSha256 compared against the zip built HERE is.
verify:
	@set -euo pipefail; \
	[ -s function.zip ] || { echo "ERROR: no function.zip to verify against; run make build" >&2; exit 1; }; \
	want=$$(openssl dgst -sha256 -binary function.zip | openssl base64); \
	status=$$($(AWS) lambda get-function-configuration --function-name $(FUNCTION_NAME) \
		--query LastUpdateStatus --output text); \
	got=$$($(AWS) lambda get-function-configuration --function-name $(FUNCTION_NAME) \
		--query CodeSha256 --output text); \
	if [ "$$status" != "Successful" ]; then \
		echo "ERROR: $(FUNCTION_NAME) LastUpdateStatus is $$status, not Successful." >&2; \
		exit 1; \
	fi; \
	if [ -z "$$want" ] || [ "$$got" != "$$want" ]; then \
		echo "ERROR: deployed CodeSha256 does not match the zip that was built." >&2; \
		echo "       local:  $$want" >&2; \
		echo "       remote: $$got" >&2; \
		exit 1; \
	fi; \
	echo "OK: $(FUNCTION_NAME) is running $(VERSION) (CodeSha256 $$got)"

## deploy: Full code deploy (build + upload + update-function-code + wait + verify)
# Sequenced with sub-makes rather than prerequisites so the order holds under -j.
deploy:
	$(MAKE) upload
	$(MAKE) update-code
	$(MAKE) verify
