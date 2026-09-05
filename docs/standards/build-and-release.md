# Builds & releases — desktop bundles, signing, lint gates, migrations

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md) so
it is read when the work touches builds, packaging, or migrations rather than
loaded into every session. `AGENTS.md` → "Workflow" carries the one-line
summary and points here; **this file is the rule.**

## Desktop bundles

- Desktop installable builds that embed local admin changes must build admin with `VITE_API_BASE_URL=https://api.nessie.works` and Tauri with `--config '{"build":{"frontendDist":"../../admin/dist"}}'`. `https://app.nessie.works` is the admin web origin, not the API origin; using it as `VITE_API_BASE_URL` leaves login stuck at "Loading providers...". See [docs/running-the-apps/overview.md](../running-the-apps/overview.md).
- Mac App Store/TestFlight builds use `pnpm --dir desktop run tauri:build:appstore`, a Mac App Store Connect provisioning profile supplied through `NESSIE_DESKTOP_APPSTORE_PROFILE`, `NESSIE_DESKTOP_SIGNING_TEAM_ID`, and an `APPLE_SIGNING_IDENTITY`. The store configuration is sandboxed and deliberately excludes the packaged executor runtime; the Developer ID build remains the executor-capable distribution. See [docs/running-the-apps/overview.md](../running-the-apps/overview.md).
- **macOS release-signing policy:** Never build, sign, install, or present an ad-hoc-signed macOS bundle unless Ondrej explicitly asks for an ad-hoc build. A distributable build or any build intended to test executor controls must use the configured `Developer ID Application` identity, `--options runtime`, and the matching `NESSIE_DESKTOP_SIGNING_TEAM_ID`. Before installing it, verify `codesign --verify --deep --strict` and confirm both `Authority=Developer ID Application:` and the expected `TeamIdentifier`. If that certificate or private key is unavailable, report the blocker and leave the currently installed app intact; a Mac App Store/TestFlight certificate is not a substitute because it deliberately omits the executor runtime.

## Lint gates and generation ordering

- Root `pnpm build`, `make build`, and production Dockerfiles are lint-gated. Do not replace them with raw build commands unless the replacement keeps an equivalent lint gate. Partial Docker build contexts must copy the root build/lint config files they invoke, including `eslint.config.js`.
- Root `pnpm build` and `pnpm typecheck` generate the Prisma client once, run
  Turbo with `@nessie/cli` excluded, then compile/typecheck the CLI through its
  prepared task. This keeps every generator outside the concurrent phase:
  concurrent generators can temporarily erase Prisma exports while sibling
  packages compile. The standalone `@nessie/cli` build/typecheck stays
  self-contained and may generate before its own compilation. CI must call the
  lint-gated root build; container flows that call Turbo directly must generate
  once in an earlier serialized step.

## Migrations are immutable

Prisma migration folders under `api/prisma/migrations/` are immutable once committed: never rename, renumber, delete, or edit one. `pnpm lint:migrations` (part of root `pnpm lint`) enforces this against the merge-base and warns on non-`CONCURRENTLY` index creation on `messages`/`task_events`/`runs`/`audit_logs`. The `upgrade-path` CI job restores the checked-in baseline fixture (`api/prisma/upgrade-fixtures/baseline.sql.gz`, regenerable via `scripts/generate-upgrade-fixture.mjs`) and proves `prisma migrate deploy` from HEAD converges it; see [docs/deployment.md](../deployment.md) "Supported upgrade paths".
