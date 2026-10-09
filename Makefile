# Developer entry points. See e2e/README.md.
#
#   make e2e IMAGE=<ref> [E2E_IMPL=go|ts] [E2E_READY_TIMEOUT=20] [E2E_STOP_BUDGET=3] [E2E_PLATFORM=linux/arm/v7]

IMAGE ?= $(TESTING_IMAGE)
NODE ?= node

export E2E_IMPL E2E_READY_TIMEOUT E2E_STOP_BUDGET E2E_PLATFORM

.PHONY: e2e
e2e:
	@test -n "$(IMAGE)" || { echo 'usage: make e2e IMAGE=<image ref> (or set TESTING_IMAGE)' >&2; exit 2; }
	$(NODE) e2e/run.mjs --image "$(IMAGE)"
