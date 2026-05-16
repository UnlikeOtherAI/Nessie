# MCP Universal Client + Connector Plugin System

> Status: active. Driver doc for the parallel-agent implementation loop.
> Phase: 3 (per `docs/implementation-phases.md` §3 steps 1–3).
> Specs: `docs/external-tool-integration.md`, `docs/tool-registry-spec.md`, `docs/secret-management-spec.md`.

## 1) Goal

Make Nessie a **universal MCP client** plus a **connector plugin system** so an org can wire any external tool surface (MCP, HTTP API, OpenAPI) into the workflow runtime with scoped install + per-principal credentials.

Mental model: an admin runs an "MCP App Store"; users authenticate the servers they want; every agent the user owns can be granted those tools. Same model for HTTP API connectors.

## 2) Confirmed decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | `shell_exec` **dropped entirely** | Security. Phase 4 territory. |
| D2 | Built-in primitives in this slice: `http_fetch`, `file_read`, `file_write`, `file_glob`. Keep existing `web_search`, `web_fetch`, `workspace_search`, `people_search`, `send_message`. | Minimum bootstrap surface. |
| D3 | Auth methods: `api_key` (configurable header + prefix), `bearer`, `basic`, `oauth2` (full callback + refresh), `none` | All in this slice. |
| D4 | `api_key` format is **configurable per server**: `headerName` (e.g. `Authorization`, `X-API-Key`), `valuePrefix` (e.g. `Bearer `, `Token `, ``) — driven by admin at catalog creation. | Different vendors use different conventions. |
| D5 | Multi-scope MCP installs: `system` (cross-org), `organization`, `project`, `team`, `channel`, `user`. Spec already supports it. | Matches user's "global / per-project / per-group / per-user" requirement. |
| D6 | Credential resolution = 7-level: `user → agent → channel → team → project → org → default`. Per-principal overrides allowed. | Matches `external-tool-integration.md` §4. |
| D7 | Credentials always stored as `secretRef` to `packages/runtime` secret resolver — never plaintext in DB. | Phase 3 secret management. |
| D8 | Tool surface UI lives inside the **Workflows section**. MCP App Store is a **separate admin section**. Installed servers appear in workflow tool pickers. | User IA decision. |
| D9 | All emitted `ToolRegistryEntry` rows start `status: pending_review`. Admin approval required before agents can call. | Matches spec defaults. |
| D10 | Use official **`@modelcontextprotocol/sdk`** for transport plumbing. Don't reinvent the protocol. | Lower risk, ecosystem-aligned. |
| D11 | Project rule: work on `main`, no branches. Parallel agents work on **disjoint file sets**. | Project `CLAUDE.md`. |

## 3) Slice plan (parallel-friendly)

| Slice | Owner files | Depends on | Wave |
|---|---|---|---|
| **B — Prisma + schemas** | `api/prisma/schema.prisma`, `api/prisma/migrations/*`, `packages/schemas/src/mcp.ts`, `packages/schemas/src/tools.ts`, `packages/schemas/src/index.ts` (re-exports only) | — | 1 |
| **A — `packages/mcp-client`** | `packages/mcp-client/src/**`, `packages/mcp-client/package.json`, `packages/mcp-client/tsconfig.json`, `packages/mcp-client/test/**` | — (self-contained) | 1 |
| **D — `packages/connectors`** | `packages/connectors/src/**`, `packages/connectors/package.json`, `packages/connectors/tsconfig.json`, `packages/connectors/test/**`, `docs/nessie-toolset.example.json` is read-only reference | — | 1 |
| **C — API routes + worker dispatch** | `api/src/services/mcp-catalog.ts`, `api/src/services/mcp-instances.ts`, `api/src/services/mcp-credentials.ts`, `api/src/services/tool-grants.ts`, `api/src/services/tool-dispatch.ts`, `api/src/routes/mcp.ts`, `api/src/routes/tools-bundles.ts`, `worker/src/run/tool-dispatch.ts`, `worker/src/run/tool-mcp.ts`, `worker/src/run/tool-http.ts` | B, A | 2 |
| **E — Admin UI** | `admin/src/features/workflows/tools/**`, `admin/src/features/admin/mcp-app-store/**`, `admin/src/api/mcp.ts`, `admin/src/api/connectors.ts`, route wiring | C contract stable | 3 |
| **F — Builtin tool migration** | Extend `packages/runtime/src/builtin-tools.ts` with `http_fetch`/`file_read`/`file_write`/`file_glob`; worker handlers in `worker/src/run/builtin-handlers/*` | B | 2 |
| **G — Review** | Parallel `feature-dev:code-reviewer` passes per merged slice | each slice on completion | continuous |

## 4) Data model (Slice B)

New Prisma models — exact field set per `tool-registry-spec.md` §3.1 + `external-tool-integration.md` §2/§4:

- `McpCatalogEntry` — admin-registered MCP definitions (the app store). Fields: `id, organizationId (null = system), name, label, description, protocol (stdio|http|sse|ws), authMethod, authConfig (Json: { headerName?, valuePrefix? } for api_key; { authorizationUrl, tokenUrl, scopes[] } for oauth2), defaultTransportConfig (Json), iconUrl?, vendor?, sourceUrl?, signature?, status (draft|published|deprecated), createdBy, createdAt, updatedAt`. Unique `(organizationId, name)`.
- `McpServerInstance` — installed instance at a scope. Fields: `id, catalogEntryId, organizationId, scopeType (system|organization|project|team|channel|user), scopeId (uuid of that scope target), credentialRef?, transportConfig (Json), discoveredTools (Json — cached tools/list result), lifecycleState (pending_setup|active|paused|error), healthLastCheckedAt, healthFailureCount, installedBy, createdAt, updatedAt`. Unique `(catalogEntryId, scopeType, scopeId)`.
- `McpServerCredentialOverride` — per-principal credential. Fields: `id, instanceId, principalType (user|agent|channel|team|project), principalId, credentialRef, createdAt, updatedAt`. Unique `(instanceId, principalType, principalId)`.
- `ToolBundle` — manifest import (Slice D). Per `tool-registry-spec.md` §3.1.
- `ToolGrant` — per `tool-registry-spec.md` §3.1.
- **Extend** `ToolRegistryEntry`: add `source (builtin|custom|mcp-remote|interactive-session)`, `transport (direct|mcp|http|stdio|pty)`, `transportConfig (Json)`, `bundleId?`, `mcpInstanceId?`, `inputSchema (Json)`, `outputSchema (Json?)`, `tags (String[])`, `status (active|pending_review|disabled)`, `version`, `createdBy`. Migration must default existing rows to `source='builtin', transport='direct', status='active'`.

Schemas in `packages/schemas/src/mcp.ts` + `tools.ts`: branded ID types, Zod schemas, TS types per `shared-type-contracts-spec.md` conventions.

## 5) MCP client (Slice A)

`packages/mcp-client` is **transport-and-protocol only**. No DB. No Nessie types beyond what it owns.

Public API:
```ts
class McpClientManager {
  open(spec: McpConnectionSpec): Promise<McpConnectionId>;
  close(id: McpConnectionId): Promise<void>;
  listTools(id: McpConnectionId): Promise<McpToolDescriptor[]>;
  callTool(id: McpConnectionId, name: string, args: unknown, opts?: { timeoutMs?: number; abort?: AbortSignal }): Promise<McpToolResult>;
  health(id: McpConnectionId): Promise<McpHealth>;
  on(event: 'state' | 'error' | 'notification', cb: ...): Unsubscribe;
}

type McpConnectionSpec =
  | { transport: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { transport: 'http'; url: string; headers?: Record<string, string> }
  | { transport: 'sse'; url: string; headers?: Record<string, string> }
  // 'ws' deferred unless trivial via SDK
```

Backed by `@modelcontextprotocol/sdk`. Internal concerns:
- connection pool, per-instance retry/backoff,
- discovery cache with TTL,
- structured errors (timeout / protocol / transport),
- credential injection happens **outside** this package — caller passes resolved headers/env.

Tests: stdio + http + sse against a local fake server (in-package test harness).

## 6) API surface (Slice C)

Endpoints per `external-tool-integration.md` §2/§3, all under `/api/`:

**Catalog (admin)**
- `GET /api/mcp/catalog`, `POST /api/mcp/catalog`, `GET/PATCH/DELETE /api/mcp/catalog/{id}`
- `POST /api/mcp/catalog/{id}/publish` / `/deprecate`

**Server instances (scoped)**
- `POST /api/mcp/servers` (body: `catalogEntryId, scopeType, scopeId, transportConfig?`)
- `GET /api/mcp/servers?scopeType=&scopeId=`
- `GET /api/mcp/servers/{id}`, `PATCH /api/mcp/servers/{id}`, `DELETE /api/mcp/servers/{id}`
- `POST /api/mcp/servers/{id}/refresh` (re-runs `tools/list`)
- `POST /api/mcp/servers/{id}/healthcheck`

**Credentials (per-principal)**
- `POST /api/mcp/servers/{id}/credentials` (body: `principalType, principalId, credentialRef`)
- `GET /api/mcp/servers/{id}/credentials`
- `DELETE /api/mcp/servers/{id}/credentials/{credentialId}`

**OAuth2**
- `GET /api/mcp/servers/{id}/oauth/start` → 302 to provider auth URL
- `GET /api/mcp/servers/{id}/oauth/callback?code=…&state=…` → stores secret, marks active
- `POST /api/mcp/servers/{id}/oauth/refresh` (worker calls when token expires)

**Tool registry surface (existing endpoints extended)**
- `GET /api/tools` honors source/transport/scope filters
- `POST /api/tools/bundles/import`, approval workflow

**Worker dispatch** (`worker/src/run/tool-dispatch.ts`):
```
toolCall → resolve ToolRegistryEntry → check ToolGrant → route by transport:
  direct → packages/runtime builtin handler
  mcp    → resolve credentials (7-level) → packages/mcp-client.callTool
  http   → packages/connectors http executor with auth_config
```

## 7) UI (Slice E)

Per **D8** the UI splits in two:

**`/admin/workflows/tools`** (inside Workflows section)
- list of tools available to the current agent / workflow context
- filter by source (builtin / mcp / http), tag, status
- checkbox matrix for grant (uses `ToolGrant` per `tool-registry-spec.md` §11.1)
- per-tool config drawer
- reusable components: `ToolBadge`, `ToolTransportPill`, `ToolPermissionPill`, `ToolCategoryIcon` (already mandated by `provider-system-and-frontend-architecture.md` §8)

**`/admin/admin/mcp-app-store`** (separate admin section)
- catalog list (admin only)
- "Add MCP server" wizard → stdio / http / sse → auth config (api_key with header+prefix, bearer, basic, oauth2)
- "My installs" view per user / scope — install button per catalog row
- per-server credential modal — per-user authentication
- health/lifecycle indicators
- once installed at a scope, server appears in `/admin/workflows/tools`

Both surfaces use the `tools`, `mcpCatalog`, `mcpServers` domain facades (one per entity, per `provider-system-and-frontend-architecture.md` §5.2). No page-local fetch.

## 8) Out of scope (deferred slices)

- Async tools with progress (`async_tools` table, §5 of spec)
- Three-layer policy intersection for remote workers (Phase 4)
- Step-up verification on credential resolve (Phase 3 Step 6 — separate work)
- OpenAPI auto-import for connectors (separate slice after this lands)
- `shell_exec` / `session:*` family (Phase 4)
- Marketplace signing infrastructure beyond `sha256` checksum field

## 9) Loop protocol

Two cron jobs drive this plan:

**Every 5 min — progress + dispatch + review + E2E**
1. `git status` + `git log --oneline -10` to know current state.
2. Read this plan; read `TaskList`.
3. For each `pending` task that is not `blockedBy` anything open: dispatch a `feature-dev` agent in the background with a self-contained prompt (file list + acceptance + ban on touching files outside the slice).
4. For each `completed` task **not yet reviewed** (per `metadata.reviewed`): dispatch a `feature-dev:code-reviewer` agent in parallel.
5. When a review passes, mark `metadata.reviewed=true` and run `pnpm --filter <root> lint typecheck build` for the affected root. Commit + push if green.
6. When `feature-dev` agent reports completion, mark task `completed`.
7. When Slice E (UI) tasks land: run an **E2E pass** with kelpie against `http://localhost:5555` (Playwright MCP, headless, as fallback). Drive the chat → catalog → install → grant → invoke flow. Capture screenshots. Attach to task metadata.
8. If everything is `completed && reviewed && e2e-passed`, write a short `## Outcome` block at the bottom of this file and stop dispatching.

**Every 2.5 hours — liveness**
1. `lsof -iTCP:5554 -sTCP:LISTEN` and `:5555` — confirm API + admin ports up.
2. `pnpm --filter @nessie/api typecheck` / `pnpm --filter @nessie/admin typecheck` — typecheck across roots.
3. `pnpm --filter @nessie/api lint` / `pnpm --filter @nessie/admin lint`.
4. `git status` — surface uncommitted drift.
5. Report findings as a `### Liveness <iso-timestamp>` block at the bottom of this file.

Both loops are durable (`durable: true`). **Limitation: Claude Code cron auto-expires after 7 days** — user must re-arm if work runs longer.

## 10) Acceptance criteria

This work is **done** when:
- `pnpm --filter @nessie/api lint typecheck build` passes
- `pnpm --filter @nessie/admin lint typecheck build` passes
- `pnpm --filter @nessie/worker lint typecheck build` passes
- `pnpm --filter @nessie/mcp-client test` passes
- **E2E browser-driven smoke** (kelpie first, Playwright MCP fallback, **always headless** unless user requests otherwise):
  - drive `http://localhost:5555` from the chat surface
  - admin adds a catalog entry through the **MCP App Store** admin page
  - install it at org scope with an API key auth config (custom header, custom prefix)
  - server transitions to `active`; tool appears in `/admin/workflows/tools`
  - grant the tool to an agent via the workflow tool picker
  - send a chat message that triggers the agent to call the tool
  - verify response renders and audit row written
  - kelpie screenshots taken at each step (catalog → install → grant → invocation → audit)
- Every Slice E UI change re-verified via kelpie before considering its task complete (per project `CLAUDE.md` Verification rule).

## 11) Status log

(loops append below)

### Tick 2026-05-16T19:18:44Z
Wave 1 still running (B/A/D in_progress, dirty files: api/prisma/schema.prisma, packages/mcp-client/, packages/connectors/). No unblocked pending tasks (C/F blocked on B, E blocked on C, E2E blocked on everything). Nothing to dispatch this tick.

### Tick 2026-05-16T19:23:00Z
Slice D landed (commit b39ac2b). Verified gates: build/typecheck/lint green, 18/18 tests pass. Marked task #5 completed; dispatched code-reviewer agent (background). Slice B + A still in progress. Protocol note: sub-agents lack TaskUpdate/TaskList tool access — they report completion in summary, orchestrator records.

### Event 2026-05-16T19:26Z
Slice B landed (commit 4eafbbf). Schemas + Prisma migration green (12/12 api tests pass, fresh-DB apply verified). Marked task #4 completed; dispatched B reviewer (background). Filed task #8 for pre-existing prisma drift (not Slice B's fault). Dispatched Slice F (now unblocked) in background. Wave status: D ✓, B ✓, A in progress; F dispatched; C still blocked on A; E blocked on C.

### Liveness 2026-05-16T19:27:06Z
- Ports: API 5554 UP (pid 62556), Admin 5555 UP (pid 34839)
- @nessie/api: typecheck OK, lint OK
- @nessie/admin: typecheck OK, lint OK
- @nessie/worker: typecheck OK, lint OK
- Uncommitted: docs/simulation/ledger.md (pre-existing, not mine), .claude/ (cron state), packages/mcp-client/ (Slice A in flight)
- Stray worktree present: /System/Volumes/Data/.internal/tmpVolume/tmp/nessie-head-review.8YVikB (detached HEAD ed119b4) — likely user-spawned review env, left alone
- Tasks: D ✓, B ✓, A in_progress, F in_progress, C blocked on A, E blocked on C, E2E blocked

### Tick 2026-05-16T19:30Z
No-op. Slice A + F still in progress; B and D reviewers running (no completion notifications). Nothing unblocked to dispatch. #8 deferred until Slice C lands.

### Event 2026-05-16T20:35Z — review findings + fixes
Three reviewer outputs landed.

- **Slice D review (1 HIGH):** off-by-one in `packages/connectors/src/formats/md.ts:41` — `+ offsetLine` double-counts the YAML body's first line. Filed task #11; dispatched fixer. Applied `+ offsetLine - 1`; companion fix in `yaml.ts` (re-enable `prettyErrors` so `linePos` propagates — was silently dropped, making the line offset untestable end-to-end). New regression test in `test/parse.test.ts` asserts YAML line 2 → markdown line 3. Verified: typecheck OK, 19/19 tests pass.
- **Slice B review (1 CRITICAL + 2 HIGH):**
  - C1: `McpCredentialPrincipalType` enum missing `organization`. Filed task #9; fixer added the value to both Prisma enum and Zod schema; new migration `20260516203329_mcp_add_organization_principal/migration.sql` with only `ALTER TYPE … ADD VALUE 'organization'`. `prisma validate` + `prisma generate` clean.
  - H2: `valuePrefix: z.string().default('')` silently substituted on omission. Changed to `z.string()` (required) per D4 explicit-configurability requirement. No callsites needed update (no literal constructions exist yet).
  - H1: `ToolRegistryEntry` pre-existing divergence from `tool-registry-spec.md §3.1` (10 spec fields absent + `toolId`/`description` naming conflicts). Pre-existing, not introduced by Slice B — filed as task #10, blocked by #1/#8 to avoid rippling into in-flight work.
- **Slice A landed (commit b569447).** Universal MCP client across stdio/http/sse with discovery cache + exponential backoff + typed error hierarchy. 18/18 tests pass. Backed by `@modelcontextprotocol/sdk@^1.29.0` per D10.

Marked tasks #4, #5, #7, #9, #11 completed (#4, #5 now `reviewed: true`). #10 deferred. Slice C now unblocked (A + B both done). Slice F still in flight; Slice C and F are file-disjoint within worker/* so they can run in parallel.

### Tick 2026-05-16T20:37Z
Slice F still actively running (transcript mtime within seconds; `worker/src/run/tools.ts` + `builtin-handlers/` dirty). Holding Slice C dispatch — F is editing `worker/src/run/tools.ts` which C would also need; dispatching both now would race. Dispatched Slice A reviewer (background) — A landed at b569447 with reviewed=false. Added blockedBy=#1 to #8 (prisma drift) for proper ordering. Next tick: if F lands, dispatch C; otherwise hold.

### Event 2026-05-16T20:42Z
Slice F landed (commit fe90026): http_fetch/file_read/file_write/file_glob handlers under `worker/src/run/builtin-handlers/`, sandbox-enforced (empty allowedRoots = hard deny), http_fetch has SSRF guards (file:// reject + manual redirects), 25/25 new tests + 50 total worker tests pass. Slice F agent split `packages/runtime/src/builtin-tools.ts` into sibling files (`-sandboxed.ts`, `-types.ts`) to respect 500-line cap and extended `worker/package.json` test glob — both acceptable extensions of ownership boundary. Marked task #2 completed (reviewed=false). Dispatched Slice F reviewer + Slice C in parallel (file-disjoint; F is read-only, C creates new api/worker files + extends `worker/src/run/tools.ts` additively). Slice A reviewer still running.

### Tick 2026-05-16T19:42Z
Note: prior tick timestamps used BST not UTC; correcting from here. Three background agents actively writing (transcript mtimes within 60s): Slice C builder, Slice A reviewer, Slice F reviewer. No unblocked tasks to claim — all remaining pending tasks (#3, #6, #8, #10) gate on #1 (Slice C). Tick-and-hold; await completion notifications.

### Event 2026-05-16T19:48Z — Slice A reviewer + fix
Slice A reviewer landed. 1 HIGH: `reconnect()` in `packages/mcp-client/src/client.ts` never invalidates the `DiscoveryCache` entry — stale tool list survives transport drops until 5-min TTL. SSE reconnect test had a misleading `implicit refresh` comment but actually returned the cached array. Verified the bug in source (no `cache.invalidate` call in the reconnect success path). Filed task #12, applied fix directly (one `this.cache.invalidate(this.id)` after `setState('ready')`), updated both HTTP and SSE reconnect tests to assert reference inequality (`notStrictEqual`) — proves a fresh `tools/list` round-trip. All 18/18 tests pass, lint+typecheck clean. Marked #12 completed, #7 `reviewed: true`. Slice C builder + Slice F reviewer still running.

### Event 2026-05-16T19:55Z — Slice F reviewer HIGH×4 closed
Slice F reviewer landed earlier in the day; this tick processed and closed all four HIGH findings in a single commit (f60e9f6).
- **H1+H2 (http_fetch SSRF/scheme guard on initial URL):** previously only the redirect target was validated. Extracted SSRF defenses into new `worker/src/run/builtin-handlers/url-safety.ts` (`assertSafeUrl`) — mirrors legacy `assertSafeFetchUrl` in `tools.ts` (intentional dupe; tracked as task #16, blocked by #1, to avoid editing `tools.ts` while Slice C does). Also created `http-fetch-error.ts` to break the circular import. Initial URL + redirect target both run through `assertSafeUrl` now. Tests: file:// rejected, localhost rejected, 169.254.169.254 rejected, redirect-to-private rejected, credentialed URL rejected.
- **H3 (sandbox symlink escape):** `extractSandboxConfig` and `assertInsideSandbox` are now async — both realpath their inputs before the prefix check. Non-existent candidates (file_write targets) walk up to the deepest existing ancestor and re-append the missing tail. Tests: symlink-escape rejected for read/write/glob. Test setups now realpath the tmpdir root so macOS `/var → /private/var` doesn't masquerade as drift.
- **H4 (dup `web_fetch` in `BUILTIN_TOOL_DEFINITIONS`):** inline entry removed; canonical `WEB_FETCH_TOOL_DEFINITION` const at L217 is the single source.
- Gates: worker typecheck + lint + 58/58 tests + build green; runtime typecheck + lint + build green. Marked #13/#14/#15 completed, #2 `reviewed: true`. Filed follow-up #16 for the `assertSafeUrl` dedupe.

### Tick 2026-05-16T19:55Z
Slice C builder still actively running (transcript mtime within 20s; dirty files: `api/package.json`, `worker/package.json`, `pnpm-lock.yaml`, six untracked `api/src/services/mcp-*.ts` + `secret-resolver.ts` + `tool-bundles.ts` + `tool-grants.ts`). Every remaining pending task (#3 E2E, #6 Slice E, #8 prisma drift, #10 ToolRegistry reconcile, #16 SSRF dedupe) blocks on #1. Nothing to dispatch. Tick-and-hold.

### Tick 2026-05-16T20:00Z
Slice C builder still running (transcript mtime 3s ago). Visible progress since last tick: `api/src/routes/mcp.ts`, `api/src/routes/tools-bundles.ts`, `api/src/services/tool-dispatch.ts`, `worker/src/run/tool-dispatch.ts`, `worker/src/run/tool-http.ts`, `worker/src/run/tool-mcp.ts` all newly present (untracked), plus `api/src/index.ts` modified — implies route wiring is happening. No reviewer/builder slots free to dispatch — all pending tasks still gated on #1. Tick-and-hold.

### Tick 2026-05-16T20:04Z
Slice C builder still active (transcript mtime ~50s ago, 1.01 MB). New since last tick: `api/src/services/tool-enum-mapping.ts` (Prisma↔Zod enum mapper, likely helping the catalog/instance services). No other changes; existing file list unchanged. All pending tasks (#3, #6, #8, #10, #16) still gated on #1. Tick-and-hold.

### Tick 2026-05-16T20:09Z
Slice C builder in test-writing phase (transcript mtime 3s ago, 1.18 MB). Five new untracked test files since last tick: `api/test/mcp-catalog.test.ts`, `api/test/mcp-instances.test.ts`, `api/test/tool-enum-mapping.test.ts`, `worker/test/tool-dispatch.test.ts`, `worker/test/tool-http.test.ts`. Likely close to finish. All pending tasks still gated on #1. Tick-and-hold.

### Event 2026-05-16T20:11Z — Slice C landed
Slice C complete (commit `16c4579`). 22 new/modified files. Gates green: api typecheck/lint/build/test (26 tests), worker typecheck/lint/build/test (69 tests). Marked #1 completed. Wave-3 unlocked: #6 (Slice E UI), #8 (prisma drift), #16 (SSRF dedupe) all now claimable. Dispatched 4 agents in parallel (file-disjoint per §3 ownership):
- **Slice C reviewer** (`feature-dev:code-reviewer`) — read-only audit of all 22 files, focus on 7-level credential chain, SSRF bypass via fetchImpl seam, secret-resolver trust boundary, dispatch ordering.
- **Slice E builder** — `admin/src/features/workflows/tools/**`, `admin/src/features/admin/mcp-app-store/**`, `admin/src/api/{mcp,connectors,toolGrants}.ts`, App Store + Workflows>Tools UI surfaces, kelpie verification required.
- **#8 prisma drift** — `api/prisma/migrations/**` only, reconciliation migration so `prisma migrate diff --exit-code` returns 0.
- **#16 SSRF dedupe** — `worker/src/run/tools.ts` + `worker/src/run/builtin-handlers/url-safety.ts`, consolidate `assertSafeFetchUrl` into the canonical home.

All four dispatched in a single message. Sub-agents lack TaskUpdate; orchestrator will mark completion based on summaries.

### Tick 2026-05-16T20:17Z
All 4 background agents (Slice C reviewer, Slice E builder, #8 prisma drift, #16 SSRF dedupe) writing within the last 5s — transcript sizes 214K / 141K / 40K / 69K. No commits since 16c4579. Working tree clean apart from the perpetual `.claude/` + `docs/simulation/ledger.md`. Remaining pending tasks (#3, #10) still gated on in-flight slices. Tick-and-hold.

### Event 2026-05-16T20:18Z — #8 prisma agent stopped + Option A authorised
Prisma drift agent correctly stopped and reported a blocker: the `thread_stream_events` table is load-bearing (`packages/runtime/src/realtime.ts:113,135,235`, `api/src/realtime/hub.ts:142,199`) but the matching `ThreadStreamEvent` model is missing from `schema.prisma`. The drift SQL therefore wanted to `DROP TABLE thread_stream_events`, which would break SSE backlog + publish. Schema is wrong vs reality.

Orchestrator authorised **Option A**: lift the read-only ban on `schema.prisma` for this task only, add the missing model so the schema matches the migrations + code, then ship the cleaned reconciliation migration. Re-dispatched the agent with the expanded scope (schema.prisma now writable for the `ThreadStreamEvent` model only; all other models still read-only). The agent must re-run `prisma migrate diff` after adding the model and confirm no other destructive statements survive.

### Event 2026-05-16T20:19Z — #16 SSRF dedupe landed
Commit `be423a5`. `worker/src/run/tools.ts` lost 100 lines (legacy `assertSafeFetchUrl` + `BLOCKED_HOSTNAMES` + IPv4/IPv6/IP helpers + unused `node:dns/promises` / `node:net` imports). Now imports `assertSafeUrl` from `./builtin-handlers/url-safety.js`. Error-class unified on `HttpFetchError` (legacy was plain `Error`); agent verified the only caller `collectWebFetchResult` consumes via `wrapTool` which only reads `error.message`. Gates: worker lint/typecheck/build/test all clean, 69/69 tests pass. Marked #16 completed. Dispatched #16 reviewer in parallel (read-only audit of the equivalence claim, caller blast radius, error-class change).
