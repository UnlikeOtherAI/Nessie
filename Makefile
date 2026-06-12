# Nessie monorepo task runner.
# Prereqs: Node.js + pnpm; Rust + Tauri prerequisites for desktop builds;
# Apple Developer account, eas login, and eas init for iOS builds; same-wifi
# LAN access for mobile login against a local API URL such as http://<ip>:5454.

.DEFAULT_GOAL := help

.PHONY: help install dev desktop mac desktop-build mobile ios-dev ios-release ios-submit android gateway build typecheck lint test grant-superadmin

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make <target>\n"} /^[a-zA-Z0-9_.-]+([[:space:]][a-zA-Z0-9_.-]+)*:.*##/ {printf "  %-18s %s\n", $$1, $$2} /^##@/ {printf "\n%s\n", substr($$0, 5)}' $(MAKEFILE_LIST)

##@ Setup
install: ## Install workspace dependencies.
	pnpm install

##@ Dev
dev: ## Run API (:5454) and admin (:5455) with hot reload.
	pnpm dev

##@ Desktop
# Requires `make dev` running in another terminal; desktop loads admin at :5455.
desktop: ## Launch the Tauri desktop app for macOS/Windows.
	pnpm --filter @nessie/desktop exec tauri dev

# Requires `make dev` running in another terminal; desktop loads admin at :5455.
mac: ## Launch the Tauri desktop app for macOS.
	pnpm --filter @nessie/desktop exec tauri dev

# Produces .app/.dmg on macOS and .msi/.exe on Windows; unsigned unless signing is configured.
desktop-build: ## Build the Tauri desktop app.
	pnpm --filter @nessie/desktop exec tauri build

##@ Mobile
# Expo Go. Set the app API base URL to your Mac LAN IP, http://<ip>:5454,
# on the same wifi because production is SSO-only.
mobile: ## Start the Expo mobile app.
	cd mobile && npx expo start

# Requires Apple Developer account, eas login, and eas init.
ios-dev: ## Build the iOS development client with EAS.
	cd mobile && npx eas-cli build -p ios --profile development

ios-release: ## Build the iOS production release with EAS.
	cd mobile && npx eas-cli build -p ios --profile production

ios-submit: ## Submit the iOS build to TestFlight.
	cd mobile && npx eas-cli submit -p ios

android: ## Build the Android development client with EAS.
	cd mobile && npx eas-cli build -p android --profile development

##@ Relay
# Requires GATEWAY_API_KEY plus PUSH_APNS_* and/or PUSH_FCM_SERVICE_ACCOUNT env.
gateway: ## Build and run the local push relay.
	pnpm --filter @nessie/gateway lint && pnpm --filter @nessie/gateway build && node gateway/dist/index.js

##@ Build
build: ## Build every workspace package with Turbo.
	pnpm build

typecheck: ## Typecheck the workspace.
	pnpm typecheck

lint: ## Lint the workspace.
	pnpm lint

test: ## Run package tests where present.
	pnpm -r --if-present test

##@ Ops
grant-superadmin: ## Grant platform super-admin to EMAIL=you@example.com.
	@test -n "$(EMAIL)" || (echo "Usage: make grant-superadmin EMAIL=you@example.com" >&2; exit 2)
	pnpm --filter @nessie/cli exec nessie grant-super-admin $(EMAIL)
