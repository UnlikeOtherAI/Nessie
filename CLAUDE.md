# Nessie

Multi-tenant, self-hosted agentic work platform. Organisations host their own Nessie instance; users collaborate in a hierarchy of Organisation → Project → Team → Channel, with RBAC, approval gates, an audit trail, a token-cost ledger, MCP connector management, triggers/scheduling, video calling, and human work distribution.

> **Voice:** Voice is a secondary, nice-to-have control surface — used mainly from the companion mobile app to issue commands — not the primary interface. The primary interface is the admin web UI (`admin/`). A voice companion (OpenAI Realtime API, `gpt-4o-realtime-preview`) exists in `macos/` but is optional and architecturally separate from the main control plane.

@./AGENTS.md

## Architecture

- **API** (`api/`, port 5454) — multi-tenant REST control plane: auth (OIDC/session), channels, tasks, approvals, triggers, MCP connector management, token ledger, audit log
- **Worker** (`worker/`) — async execution service: agentic loop, task scheduling, trigger delivery, mailbox processing
- **Admin** (`admin/`, port 5455) — full product interface for operators and knowledge workers
- **Web** (`web/`) — public landing page only
- **Packages** (`packages/`) — shared runtime, scheduling, policy, and type libraries

Legacy single-user server lives in `src/` and is being removed — do not rely on it for new work.

## Tech

- Node/TypeScript (strict mode), Fastify, Prisma + PostgreSQL
- Multi-tenancy: Organisation → Project → Team → Channel schema with `organization_id` scoping on all child tables
- RBAC policy engine with deny-overrides; OIDC SSO with PKCE
- Agentic loop: max 12 iterations / 20 tool calls / 90 s / cost cap per run
- MCP connector management (REST, not JSON-RPC): `api/src/routes/mcp.ts`
- MDNS/Bonjour — backend advertises `_nessie._tcp` for local network discovery

## Git — worktrees mandatory

- The main project checkout must always stay on `main`. Never switch branches in it.
- Every task — and every parallel agent/CLI — does its work in its own git worktree under `.worktrees/` (gitignored), on a task-specific branch. Never edit the main checkout directly.
- Never reset, clean, or discard another worktree's or agent's work.
- Merge finished work into `main` only after review, linting, and tests pass. Then in the main checkout run `git switch main && git pull --ff-only`, remove the worktree (`git worktree remove …`), and delete the merged branch.

## Dev mode (hot reload)

- `pnpm dev` (repo root) runs the **API (5454) and admin (5455) together with hot reload** — `turbo run dev --parallel`. Admin source edits hot-reload via Vite HMR; API source edits restart the server via nodemon. Use this for local work; do not hand-build the admin to see changes.
- **Polling is required.** The repo lives under `/System/Volumes/Data/.internal/…` (a macOS data-volume firmlink path) where fsevents does not deliver change events, so native watchers never fire. Vite uses `server.watch.usePolling` (`admin/vite.config.ts`) and the API uses `nodemon --legacy-watch`; do not remove these or hot reload silently breaks.
- After starting/restarting a dev server, verify it: hit `GET /health` (5454) and `GET /` (5455), and confirm `@vite/client` is present in the served admin HTML.

## Build (production / CI)

- `pnpm --filter @nessie/admin build` produces the static admin bundle (`dist/`); `pnpm --filter @nessie/admin preview` serves it. This is for prod/CI, **not** the local dev loop — use `pnpm dev` instead.
- Rebuild the worker after every turn where worker code changed: `pnpm --filter @nessie/worker build`. In local mode the API runs the worker **embedded from its built `dist`** (`import('@nessie/worker')`), so worker source edits do not take effect until rebuilt. The dev API watches `worker/dist`, so a rebuild auto-restarts the embedded worker.

## Production deployment

- Production is **self-hosted on Hetzner** (`178.105.82.46`) as Docker
  containers, reusing the host's shared Caddy edge proxy and Docker networks
  (`edge`/`db`). It is **not** GCP Cloud Run — the old GCP workflow/spec are
  retired (`docs/done/phase2-gcp-deployment-spec.md` is historical).
- URLs: admin `https://nessie.unlikeotherai.com`, API
  `https://api.nessie.unlikeotherai.com`. TLS is automatic (Caddy + Let's
  Encrypt); DNS is Cloudflare, DNS-only.
- Stack: `nessie-api` + `nessie-worker` (one `Dockerfile.app` image, command
  override) + `nessie-admin` (static nginx) + a dedicated `nessie-postgres`
  (pgvector — the shared Postgres lacks the `vector` extension). No Redis (queue
  and realtime are Postgres-backed). Mode is `selfHosted`; first login is the
  one-time bootstrap owner URL.
- Compose: `infrastructure/compose/docker-compose.prod.yml`. Redeploy with
  `infrastructure/compose/redeploy.sh` after rsync'ing to `/srv/nessie`.
- **Authoritative guide: [docs/deployment.md](docs/deployment.md)** — first
  deploy, redeploy, config reference, MCP secret store, and SSO status.

## Linting

- **TypeScript**: strict mode (`strict: true` in tsconfig), ESLint with `max-len`, `noImplicitAny`, `noUnusedLocals`
- **Swift**: SwiftLint with strict mode, warning treated as error in CI

## Theming / design system

- The admin is fully color-themed via CSS custom properties. **All color lives in
  `admin/src/styles.css`** — the base `:root` is the default "nebula" theme, and
  each `[data-theme="<id>"]` block re-declares the same tokens. Components carry
  **no** raw hex or Tailwind named-color utilities; they reference tokens via
  `var(--x)` / `bg-[var(--x)]`.
- Switcher: `ThemeProvider` (`admin/src/providers/`) + Appearance page
  (`/settings/appearance`); choice persists to `localStorage["nessie.theme"]`.
- Adding a theme = add a `[data-theme]` block (redeclare every token) + register
  the id in `ThemeProvider`. See [docs/plans/2026-06-10-design-system-theming.md](docs/plans/2026-06-10-design-system-theming.md).

## Ports — NON-NEGOTIABLE

- **API**: `5454` (local dev) — always. Do not kill or restart without restarting on the same port.
- **Admin**: `5455` (local dev) — always. Kelpie verification MUST use `http://localhost:5455`.
- Never use any other port for these services in local dev.
- Moved from 5554/5555 on 2026-06-11 because an Android emulator (`gpteen_api34`) squats on 5554/5555 — see the emulator-port-conflict memory.
- **Production is unchanged:** the API container's internal port stays `5554`, pinned via `NESSIE_API_PORT` in `infrastructure/compose/docker-compose.prod.yml` (behind the shared Caddy proxy). Only local dev moved.

## Verification

- Every UI/frontend change must be verified using kelpie before the work is considered done.
- Run `kelpie "http://localhost:5455/<path>"` to screenshot the affected page and confirm correct rendering.
- Use Playwright (`mcp__plugin_playwright`) only as a fallback if kelpie cannot be launched. Always run Playwright headless unless the user explicitly requests otherwise.

## MCP Integration

The live API server (`api/`) exposes a **REST MCP connector-management surface** under `/api/mcp/*`. This is for managing third-party MCP connectors (register, list, approve, activate, delete) — it is not a JSON-RPC tool server.

> **Legacy JSON-RPC MCP server removed.** The old `GET /mcp` / `POST /mcp` JSON-RPC server (`src/mcp/server.ts`) that exposed `send_message`, `invoke_tool`, `tools/list`, and 37 tools existed only in the legacy `src/` tree, which is being deleted. There is no JSON-RPC `/mcp` endpoint on the live `api/` server.

See [docs/functionality.md](docs/functionality.md) for the authoritative API surface description. Section §7 describes the removed legacy MCP server for historical reference.

## MDNS

The backend registers `_nessie._tcp` on port 4317 via Bonjour/mDNS on launch. This feature is part of the legacy `src/` runtime; the new `api/` server does not yet register mDNS. Clients on the same network can discover the legacy server automatically without hardcoded IPs.

## Docs

- [brief.md](docs/brief.md) — Historical architecture brief (see banner)
- [build-ai-coworker.md](docs/done/build-ai-coworker.md) — Historical macOS app build plan (moved to done/)
- Finished documents belong in `docs/done/`.

## Documentation & Goals — update with every change

Keeping docs and goals in sync with the code is part of the definition of done, not a follow-up task. With every change:

- Update the affected `docs/` document(s) in the same turn when behaviour, architecture, or a public contract changes.
- Update the stated goal where it lives (`docs/brief.md`, the relevant spec, `CLAUDE.md`/`AGENTS.md`) when scope or a standard changes.
- Delete or move superseded docs to `docs/done/` — never leave a spec describing code that no longer exists.
- Changes to the MCP surface, ports, build steps, or workflow must update `CLAUDE.md`/`AGENTS.md`.

See `AGENTS.md` → "Documentation & Goals" for the authoritative rule.
