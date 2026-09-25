.DEFAULT_GOAL := help
PYTHON ?= backend/.venv/bin/python
RUFF ?= backend/.venv/bin/ruff
PILOT_SOURCE ?= ../ArknightsRelationshipPilot

.PHONY: help install check check-tools check-backend check-frontend check-frontend-source check-postgres test-upstream assets-install assets-verify

help:
	@echo 'install         Install locked backend and frontend dependencies'
	@echo 'check           Run isolated SQLite backend checks and frontend build/tests'
	@echo 'check-frontend-source  Run frontend types and tests without the local asset input'
	@echo 'check-postgres  Run backend checks with ATLAS_TEST_DATABASE_URL (dedicated database)'
	@echo 'test-upstream   Validate upstream data and run NPC rebuild tests (needs sibling projects)'
	@echo 'assets-install  Optionally restore ASSET_PACKAGE into a missing resource directory'
	@echo 'assets-verify   Verify the fixed-version resources included in the repository'

install:
	cd backend && uv sync --frozen
	cd frontend && npm ci

check: check-backend check-frontend check-tools

check-tools:
	$(RUFF) check scripts
	$(PYTHON) -m unittest discover -s scripts -p 'test_*.py'
	node --test --test-isolation=none assets/verify-resources.test.mjs
	node --test --test-isolation=none frontend/scripts/container-layers.test.mjs frontend/scripts/asset-delivery.test.mjs

check-backend:
	$(RUFF) check backend scripts/check_backend.py
	$(PYTHON) scripts/check_backend.py sqlite

check-frontend:
	cd frontend && npm run build
	cd frontend && npm run test:game
	cd frontend && npm run test:atlas
	cd frontend && npm run test:preferences

check-frontend-source:
	cd frontend && npm run typecheck
	cd frontend && npm run test:game
	cd frontend && npm run test:atlas
	cd frontend && npm run test:preferences

check-postgres:
	$(RUFF) check backend scripts/check_backend.py
	$(PYTHON) scripts/check_backend.py postgres

test-upstream:
	node scripts/validate-graph-data.mjs --data dist/data --source "$(PILOT_SOURCE)"
	node --test scripts/build-npc-data.test.mjs

assets-install:
	@test -n "$(ASSET_PACKAGE)" || (echo 'Set ASSET_PACKAGE=/path/to/resource-pack.tar.gz'; exit 1)
	$(PYTHON) scripts/resource_pack.py install --package "$(ASSET_PACKAGE)"

assets-verify:
	node --input-type=module -e 'import {readFile} from "node:fs/promises"; import {verifyResources} from "./assets/verify-resources.mjs"; const m=JSON.parse(await readFile("assets/resource-manifest.json","utf8")); await verifyResources(`assets/local/$${m.version}`,m); console.log(m.version);'
	node scripts/verify-preferences-assets.mjs
