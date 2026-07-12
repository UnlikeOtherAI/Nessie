# Nessie Agent Standards

## Workflow

- Worktrees are mandatory. The main project checkout always stays on `main`; never edit it directly. Every task — and every parallel agent/CLI — works in its own git worktree under `.worktrees/` (gitignored), on a task-specific branch. Never reset, clean, or discard another worktree's or agent's work. When any task is done, merge the completed task branch into `main` in the same turn after review, linting, and tests pass; do not leave completed work parked in a worktree unless the user explicitly says not to or verification is blocked. After merge, remove the worktree and delete the merged branch.
- Commit and push after every turn. No exceptions. If there is nothing to commit, skip.
- Local dev runs with hot reload via `pnpm dev` (root) — API (5454, nodemon) + admin (5455, Vite HMR) in parallel. (Moved from 5554/5555 to dodge an Android emulator squatting on those ports; production internal port stays 5554.) Admin and API source edits reload automatically; **do not hand-build the admin to see changes.** The repo sits on a macOS data-volume path where fsevents is dead, so watchers must poll: Vite `server.watch.usePolling` and `nodemon --legacy-watch`. Don't remove these.
- Desktop installable builds that embed local admin changes must build admin with `VITE_API_BASE_URL=https://api.nessie.works` and Tauri with `--config '{"build":{"frontendDist":"../../admin/dist"}}'`. `https://app.nessie.works` is the admin web origin, not the API origin; using it as `VITE_API_BASE_URL` leaves login stuck at "Loading providers...". See `docs/running-the-apps.md`.
- Rebuild the worker (`pnpm --filter @nessie/worker build`) after every turn where worker code changed: in local mode the API runs the worker embedded from its built `dist`, so source edits don't take effect until rebuilt. The dev API watches `worker/dist`, so a rebuild auto-restarts the embedded worker.
- `pnpm --filter @nessie/admin build` is for production/CI bundles only, not the dev loop.
- Root `pnpm build`, `make build`, and production Dockerfiles are lint-gated. Do not replace them with raw build commands unless the replacement keeps an equivalent lint gate. Partial Docker build contexts must copy the root build/lint config files they invoke, including `eslint.config.js`.
- After every server start/restart, verify it is actually running: check the process is up, hit a health endpoint, or confirm the expected log output appears.
- Package manager: **pnpm**.

## Code Quality

- Strict linting. Builds must not pass without all lints passing.
- No patches on patches. No fallbacks unless required by functionality. Diagnose and fix root causes.
- Before reusing code that hasn't been reused before: pause, plan a refactor, execute it maintaining best architectural practices, then reuse.
- Code files: 500 lines max. Exceeding the cap is an architectural signal — split along cohesive responsibility seams via a real refactor, never by dumping into `-extras`/`-helpers` files.
- No over-engineering. Build the simplest thing that satisfies the current goal. No premature abstractions, no speculative generality, no backwards-compat shims unless functionality requires them.

## Documentation & Goals — update with every change

Every change must keep documentation and stated goals in sync with the code. This is part of the definition of done, not a follow-up.

- When behaviour, architecture, or a public contract changes, update the affected `docs/` document(s) in the same turn.
- When a change alters a project goal or scope, update the goal where it is stated (`docs/brief.md`, the relevant spec, and this file / `CLAUDE.md` if the standard itself changes).
- When a feature is removed or superseded, delete or move its doc to `docs/done/` — do not leave stale specs describing code that no longer exists.
- A change that touches the MCP surface, ports, build steps, or workflow must update `CLAUDE.md`/`AGENTS.md` accordingly.
- If a change has no documentation impact, that is fine — but the decision to skip must be deliberate, not forgotten.

## Verification

- Every UI change must be visually verified using kelpie before considering the work complete.
- Run `kelpie "http://localhost:5455/<path>"` to screenshot the affected page and confirm the feature renders correctly.
- Use Playwright (`mcp__plugin_playwright`) only as a fallback if kelpie cannot be launched. Always run Playwright headless unless the user explicitly requests otherwise.
- This applies to all frontend work: new components, layout changes, styling fixes, and interaction flows.

## Architecture

- All standards, specs, and design decisions live in `docs/`.
- When a document is finished, move it to `docs/done/`.
- Legacy code lives in `src/`. New code goes into `api/`, `admin/`, `web/`, `worker/`, `packages/`.
- Do not import from `src/` in new code. All reusable concepts must be re-implemented in `packages/`.
- Follow the architecture guardrails and anti-pattern list in `docs/architecture.md` before creating files, reorganizing code, or reusing logic.
- Follow the provider system and frontend architecture in `docs/provider-system-and-frontend-architecture.md`.
- Follow the implementation phases in `docs/implementation-phases.md`.
- User-authored MCP connectors may use HTTP/SSE remote endpoints only. Cloud-side stdio process execution is disabled at catalog, instance, dispatch, and worker boundaries; HTTP/SSE/OAuth URLs must pass the SSRF guard. Use remote MCP runners for private networks or local machines.
- MCP connector management logic (catalog, instances, probe, projection, credentials, secret store, library, discovery, OAuth) lives in `@nessie/mcp-manage` and is shared by the API routes and the worker's personal-assistant `connector_*` tools — do not fork it into either side. Scope rules: owners manage all install scopes, admins the shared scopes, members their own user scope; user-scope tools auto-activate and surface only in the installing user's PA runs. OAuth is dynamic by default (RFC 9728/8414 discovery, RFC 7591 client registration, PKCE, pg-backed state, auto-refresh); static client configs remain supported. Owners/admins can lock catalog entries against member self-service (install-time gate, endpoint-match aware). Toolset assembly defers MCP schemas behind `mcp_find_tools`/`mcp_load_tools`/`mcp_drop_tools` above `NESSIE_MCP_INLINE_TOOL_LIMIT` (default 12) to protect agent context. External-agent products (e.g. DeepSignal) run as a per-user DM channel with `Agent.executionMode = external_mcp` — turns proxy straight to the product's MCP endpoint with **no Nessie inference**; the worker driver + API history hydration share the `@nessie/mcp-manage` `resolveInstanceMcpTransport`/`callInstanceTool` seam, and a per-org HMAC-verified webhook (`/api/integrations/deepsignal/events`) delivers proactive insights as a **coalesced, budgeted rolling digest** (one "N new signals" message per user, updated in place; fresh digests capped per user per window — env-tunable heuristics, not law) rather than one card per event; the Signals page renders them as a triaged Overview/Inbox. See `docs/external-tool-integration.md` §2 + §5 and `docs/plans/2026-07-09-deepsignal-integration.md`.
- DeepWater is usable as a tool by any permitted agent: enabling DeepWater for a team (owner-only team-enablement toggle) provisions a **team-scoped** tool-projecting `McpServerInstance` from the `deep-water` catalog entry and projects the plugin manifest's `research_*` tools into `ToolRegistryEntry` as `active` (surfaced as `mcp_research_*`); disabling removes it. Team scope reaches every agent run in the team, so the tools are grantable to any agent (PA or shared) via per-agent toolPolicy (default off); first-party team-enable stands in for the manual install + admin-approve gate, and per-user OAuth resolves at dispatch. `deep_water_run_update` is no longer PA-only — any granted shared agent can write the durable run record back.
- deep.agent crawl web scanning is an MCP connector template: install a Nessie-reachable SSE endpoint (`/mcp/sse`) with bearer auth, then approve/grant the discovered tools. The crawl library implementation belongs behind the deep.agent service boundary; do not embed Crawl4AI's Python package in the API/worker or expose an unauthenticated crawler to the public internet.

## File storage & accounting — single chokepoint

- **All blob file operations** — store, stream, download, delete, version, attachment-linking — MUST go through the one `@nessie/runtime` `FileService` (`createFileService`). Never call `getStorage` / `storage.*` or `prisma.attachment` for file bytes from anywhere else (routes, worker tools, services). Build it once per process from `config.storage`.
- **Storage accounting is part of the file op, not optional.** Every store increments and every delete decrements the `StorageUsageEvent` ledger (signed-byte deltas). This is what keeps per-organization / team / space / uploader usage always known, and it is enforced by the `FileService` so it can never be skipped. Uploads are quota-gated via `Budget.storageLimitBytes`.
- Uploads can be up to `NESSIE_MAX_UPLOAD_BYTES` (default 5 GiB), so file paths must **stream** (never `toBuffer`/`readFile`). `Attachment.sizeBytes` is a `BigInt`; serialize it as a string at API boundaries.
- Production storage is S3-compatible (self-hosted MinIO); local dev defaults to `filesystem`. See `docs/deployment.md`.
