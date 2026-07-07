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
- **Guardrails** ([docs/architecture.md](docs/architecture.md)) — things to avoid when creating files, organizing code, sharing logic, and preserving security/testability boundaries

Legacy single-user server lives in `src/` and is being removed — do not rely on it for new work.

## File storage & accounting — single chokepoint

- **All blob file work** (store, stream, download, delete, version, attachment-linking) goes through the one `@nessie/runtime` `FileService` (`createFileService`). Never call `getStorage` / `storage.*` or `prisma.attachment` for file bytes anywhere else — route uploads, worker tools, avatars, and logos all use the `FileService`.
- **Accounting is part of every file op, not optional:** each store writes a `+bytes` and each delete a `-bytes` `StorageUsageEvent`, so org / team / space / uploader usage is always known. Uploads are quota-gated by `Budget.storageLimitBytes`.
- Uploads stream end-to-end (default cap `NESSIE_MAX_UPLOAD_BYTES` = 5 GiB; never buffer whole files). `Attachment.sizeBytes` is `BigInt`, serialized as a string at API boundaries.
- Backend = S3-compatible MinIO in production, `filesystem` in local dev. KB file nodes (`KnowledgePage.kind = file`) and page attachments live alongside documents — see [docs/knowledge-base-requirements.md](docs/knowledge-base-requirements.md).

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
- When any task is done, merge the completed task branch into `main` in the same turn after review, linting, and tests pass; do not leave completed work parked in a worktree unless the user explicitly says not to or verification is blocked.
- Then in the main checkout run `git switch main && git pull --ff-only`, remove the worktree (`git worktree remove …`), and delete the merged branch.

## Dev mode (hot reload)

- `pnpm dev` (repo root) runs the **API (5454) and admin (5455) together with hot reload** — `turbo run dev --parallel`. Admin source edits hot-reload via Vite HMR; API source edits restart the server via nodemon. Use this for local work; do not hand-build the admin to see changes.
- **Polling is required.** The repo lives under `/System/Volumes/Data/.internal/…` (a macOS data-volume firmlink path) where fsevents does not deliver change events, so native watchers never fire. Vite uses `server.watch.usePolling` (`admin/vite.config.ts`) and the API uses `nodemon --legacy-watch`; do not remove these or hot reload silently breaks.
- After starting/restarting a dev server, verify it: hit `GET /health` (5454) and `GET /` (5455), and confirm `@vite/client` is present in the served admin HTML.

## Build (production / CI)

- `pnpm --filter @nessie/admin build` produces the static admin bundle (`dist/`); `pnpm --filter @nessie/admin preview` serves it. This is for prod/CI, **not** the local dev loop — use `pnpm dev` instead.
- Desktop installable builds that embed local admin changes must build admin
  with `VITE_API_BASE_URL=https://api.nessie.works`, then run Tauri
  with `--config '{"build":{"frontendDist":"../../admin/dist"}}'`. Do not use
  the admin web origin (`https://app.nessie.works`) as the API base URL;
  login will stall at "Loading providers...". See
  [docs/running-the-apps.md](docs/running-the-apps.md).
- Rebuild the worker after every turn where worker code changed: `pnpm --filter @nessie/worker build`. In local mode the API runs the worker **embedded from its built `dist`** (`import('@nessie/worker')`), so worker source edits do not take effect until rebuilt. The dev API watches `worker/dist`, so a rebuild auto-restarts the embedded worker.
- Root `pnpm build`, `make build`, and the production Dockerfiles are lint-gated. Keep lint in those build paths instead of replacing them with raw `turbo build` or package build calls. Partial Docker build contexts must copy the root build/lint config files they invoke, including `eslint.config.js`.

## Production deployment

- Production is **self-hosted on Hetzner** (`178.105.82.46`) as Docker
  containers, reusing the host's shared Caddy edge proxy and Docker networks
  (`edge`/`db`). It is **not** GCP Cloud Run — the old GCP workflow/spec are
  retired (`docs/done/phase2-gcp-deployment-spec.md` is historical).
- URLs: public web `https://nessie.works`, admin `https://app.nessie.works`,
  API `https://api.nessie.works`. TLS is automatic (Caddy + Let's Encrypt);
  DNS is Cloudflare, DNS-only.
- Stack: `nessie-api` + `nessie-worker` (one `Dockerfile.app` image, command
  override) + `nessie-admin` (static nginx) + a dedicated `nessie-postgres`
  (pgvector — the shared Postgres lacks the `vector` extension). No Redis (queue
  and realtime are Postgres-backed). Mode is `selfHosted`; first login is the
  one-time bootstrap owner URL.
- Compose: `infrastructure/compose/docker-compose.prod.yml`. Redeploy with
  `infrastructure/compose/redeploy.sh` after rsync'ing to `/srv/nessie`.
- The API trusts `X-Forwarded-For` only when `NESSIE_API_TRUSTED_PROXY_HOPS`
  is set. Production behind Caddy sets it to `1`; local/dev defaults to `0`
  and ignores forwarded client IP headers.
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
  (`/settings/appearance`); choice persists locally in
  `localStorage["nessie.theme"]` for logged-out screens and is also saved to
  `User.preferences.theme` for signed-in users so web, desktop, and mobile use
  the same account theme.
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

The management core lives in the shared **`@nessie/mcp-manage`** package (catalog, instances, probe, tool projection, credentials, OAuth, encrypted secret store, SSRF wrapper) so the API routes and the worker's personal-assistant tools share one implementation. On top of it:

- **Library + discovery**: `GET /api/mcp/library` (curated well-known remote servers + live search of the official MCP registry, HTTP/SSE remotes only), `POST /api/mcp/discover` (probe a pasted link for an MCP endpoint + auth requirements), `POST /api/mcp/library/import`. Surfaced as the admin Connectors page **Library** tab with a guided one-click install.
- **Personal-assistant connector tools** (PA-only builtins): `connector_list`, `connector_library_search`, `connector_discover`, `connector_install`, `connector_authorize`, `connector_test`, `connector_set_secret`, `connector_uninstall` — full conversational setup from just a service name or URL, with secrets stored encrypted (`POST /api/mcp/instances/:id/secret` is the UI equivalent).
- **Dynamic OAuth** (MCP authorization spec): `{ method: "oauth2" }` with no static client triggers metadata discovery (RFC 9728/8414), Dynamic Client Registration (RFC 7591, one public client per org × issuer in `mcp_oauth_clients`), authorization-code + PKCE S256 + RFC 8707 `resource`, pg-backed one-shot state (`mcp_oauth_states`), per-user token placement, and automatic refresh at probe/dispatch. Notion/Linear/Sentry/Atlassian/Asana are curated OAuth entries — users just sign in. Set `NESSIE_API_PUBLIC_URL` in prod so the worker can mint callback URLs.
- **Scoped sharing**: owners manage every install scope; org **admins** manage the shared scopes (organization/project/team/channel); members self-serve at their own user scope and see shared installs they can reach. Worker toolset assembly is scope-aware (user-scope connectors surface only in the installing user's PA runs); user-scope installs auto-activate their discovered tools, shared scopes keep the `pending_review` gate. See `docs/external-tool-integration.md` §2.
- **Admin locking**: owners/admins can lock a catalog entry (`/lock`, `/unlock`); members cannot install it or re-register its endpoint under another name (🔒 pill + disabled install in the UI, clear refusal from the PA). Install-time gate only — existing instances keep working.
- **Context-safe toolsets**: above `NESSIE_MCP_INLINE_TOOL_LIMIT` (default 12) exposed MCP tools, agent runs get three meta tools (`mcp_find_tools` → `mcp_load_tools` → call directly, `mcp_drop_tools` to free) over a live tool list instead of every schema inlined — see `docs/external-tool-integration.md` §5.

User-authored MCP connectors are limited to HTTP/SSE remote endpoints. The
cloud API and worker reject stdio process execution for catalog/instance data,
and HTTP/SSE/OAuth URLs are checked by the shared SSRF guard before save or use.
Use remote MCP runners for private networks, local machines, or subprocess-based
servers.

deep.agent crawl web scanning uses the MCP connector path: install a
Nessie-reachable SSE endpoint (`/mcp/sse`) with bearer auth, approve the
discovered tools, and grant them to agents. The crawl library implementation
belongs behind the deep.agent service boundary; do not embed the Crawl4AI
Python package in the API/worker or expose an unauthenticated crawler to the
public internet.

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
