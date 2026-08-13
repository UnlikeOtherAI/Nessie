# Architecture audit — structure, naming, layering (2026-08-13)

Status: **complete — primary audit, all six area passes, and both external
reviews (Kimix, Codex Sol) folded in and verified** (Appendix A). No code was
changed; this document is the deliverable.

Scope: every workspace (`api`, `admin`, `web`, `worker`, `cli`, `mobile`,
`desktop`, `gateway`, `executor`, `macos`, `packages/*`, plus non-workspace
top-level dirs) held against the repo's own stated architecture: `AGENTS.md`
(rule zero, code quality), `CLAUDE.md`, `docs/architecture.md` (routes never
own business workflows; 500-line cap split along cohesive seams; no catch-all
buckets; shared rules in the smallest owning package; egress IP-pinned via
`safeFetch`; no import-time side effects; docs updated with every change).

Method: direct inspection at `eab4622c` (Sol addendum verified at
`bde3b1cc`); six parallel area subagents (api, worker, admin,
packages/dependency-graph, peripheral/hygiene, docs-drift); two independent
external reviewers on a shared brief (Kimix, Codex Sol). Every high-severity
claim below was re-verified against the working tree before acceptance;
reviewer disagreements are recorded in Appendix A rather than silently
resolved. Sol's deeper security-boundary findings are in the Addendum before
Priority 3.

---

## Priority 1 — high impact

### 1. The documented pa-tools anti-pattern is still shipping: forked channel authz

**Evidence.** `worker/src/run/pa-tools/channels.ts:14` still opens with the
exact comment `AGENTS.md` names as "the anti-pattern, not a precedent" —
`// Channel-manage authz mirrored from api/src/services/channels.ts
canManageChannel:` — followed by a full local re-implementation of the
channel/org/team owner-admin checks, slug-conflict detection, and channel
list/update/archive/join against raw Prisma. `pa-tools/access.ts:139-146`
(`buildVisibleChannelWhere`) duplicates the visibility where-clause of
`api/src/services/channels.ts:41-47` and is consumed by five more pa-tools
files. The reformed pattern exists ten files away: `pa-tools/provisioning.ts`
correctly imports everything from `@nessie/workspace-admin`.

**Why it's a problem.** Two independent copies of "who may manage a channel"
and "which channels a user can see" will drift, and the drift is an
authorization bug by construction. The repo wrote the rule, built the shared
package, migrated the five provisioning builtins — and left the older channel
tools on the fork.

**Fix.** Move `canManageChannel` and the visible-channel where-builder into
`@nessie/workspace-admin` (api re-exports, as `policy.ts`/`agents.ts` already
do) and route `channel_list`/`channel_update`/`channel_archive`/`channel_join`
through the same service functions their REST routes call.

**Impact: high (authz drift). Effort: small–medium — package and pattern
already exist.**

### 2. Login-flow egress sits outside the pinned-egress chokepoint

**Evidence (flagged by Kimix; confirmed by direct inspection).** The repo's
headline egress rule is `safeFetch`/`pinnedFetch` for any operator- or
caller-influenced address, because validate-then-`fetch` leaves a
DNS-rebinding window. The rule is honored on the model/tool/MCP surface
(`http-fetch.ts`, `mcp-manage` OAuth, FCM, push validation — all pinned). But:

- `api/src/services/external-auth.ts` (OIDC login) uses **bare `fetch`** for
  discovery (L58), the token exchange (L118), and userinfo (L141). The
  `issuerUrl` comes from config validated only as `z.string().url()` — no
  SSRF/egress guard — and `token_endpoint`/`userinfo_endpoint` are taken from
  the fetched discovery document and **never re-validated against the issuer
  origin**, so the authorization code + PKCE verifier are POSTed to whatever
  URL the document names (the classic OIDC mix-up seam).
- `api/src/services/uoa-session.ts` uses bare `fetch` for the UOA token
  exchange (L332) and directory read (L271), carrying live bearer material
  (env-derived base URL — lower risk, but outside the seam).
- `api/src/services/github.ts:21` and `designer.ts:80` also bypass the
  chokepoint (fixed hosts; low risk; listed for completeness).

**Why it's a problem.** The trust anchors of the login flow get *weaker*
egress handling than the connector tokens the login flow protects. And
structurally, "which calls must be pinned" is enforced by convention only —
nothing stops a validated URL from being dialed unpinned.

**Fix.** Route OIDC discovery/token/userinfo through the pinned transport and
require token/userinfo endpoints to share the issuer origin (quick win); then
add an ESLint restriction on bare `fetch(` in `api/src`, `worker/src`,
`packages/*/src` outside an allowlist so the rule is mechanical.

**Impact: high (credential-bearing SSRF seam contradicting a documented
security rule). Effort: small for the OIDC fix; medium for the lint seam.**

### 3. Whole API domains bypass the service layer; comms OAuth lives in a route

**Evidence.** 32 files in `api/src/routes/` call `prisma.` directly. Worst:
`comms-connections.ts` (473 lines, 23 call sites) owns the entire OAuth
connect/callback/disconnect lifecycle inline — state-row creation (L130),
atomic single-use state consume (L183-190), credential purge transaction
(L418-425), five-table cascading delete (L453-459) — with its service-shaped
collaborators filed under `routes/comms/` and **no `services/comms-*.ts` at
all**. `routes/projects.ts` (13 sites, full CRUD + membership),
`routes/teams.ts`, `routes/organizations.ts`, `routes/auth-security.ts`
(includes a `$transaction`), and `routes/disclosure-grants.ts` similarly have
no corresponding service. The good models already in-tree:
`routes/executors.ts` keeps no business logic (imports ~24 functions from
`@nessie/executor-manage`), and `routes/workflows.ts` is a clean registrar
over a `workflows/{templates,installations,runs}` directory.

**Fix.** Ratchet: an ESLint restriction on `prisma` in `api/src/routes` with
the current 32 files grandfathered in a shrinking allowlist. Extract
`services/comms-connections.ts` first (workflow-shaped, security-relevant),
then `projects`/`teams`/`organizations` (mechanical CRUD).

**Impact: high. Effort: medium, incremental; the lint ratchet is a quick win.**

### 4. The workflows subsystem has outgrown the architecture in every tier

**Evidence (cap is 500 lines):** `api/src/services/workflows.ts` **1,989** —
the largest code file in the repo, with four separable domains already visible
(graph/step validation L177-649, templates L765-928, installations L930-1188,
runs + step-run actions L1190-1988). `worker/src/control/workflows.ts`
**1,180** — six domains (binding/JMESPath resolution, agent-task dispatch,
environment-launch validation, terminal transitions, the step-engine
`while (true)` scheduler). `worker/src/run/workflows.ts` **673** and
`admin/src/lib/workflow-designer/serialization.ts` **598** — the latter also
carrying **module-level mutable state** (`currentLoadedStepOrder`, L388-400:
set by `parseWorkflowTemplate`, silently consumed by `buildWorkflowGraph`).
Structure confusion compounds it: two files named `workflows.ts` in sibling
worker dirs, `workflow-*` siblings scattered across both, `control/workflows.ts`
importing from `run/workflows.ts` although the workflow engine is not an agent
run. The admin's workflow designer is also hard-coded light-only (finding 13)
— the newest subsystem is drifting from every convention at once. Note the
route tier is already exemplary (finding 3), so the target shape exists.

**Fix.** Split the api service into `workflow-templates` /
`workflow-installations` / `workflow-runs` / `workflow-graph-validation`
(mirroring its own routes directory); split worker control into
`workflow-bindings` / `workflow-agent-dispatch` + engine; rename
`run/workflows.ts` → `workflow-state.ts` or gather the family under one
`workflow/` dir; make the serialization step-order state an explicit
parameter.

**Impact: high. Effort: large — schedule as its own tracked task.**

### 5. Documentation front door and operating instructions describe a deleted product

**Evidence** (all re-verified; `src/` was deleted 2026-05-30):

- `README.md` still says "Voice-first personal AI agent for macOS", documents
  a backend on `http://127.0.0.1:4317` with JSON-RPC `GET/POST /mcp`, lists
  `bun` as a prerequisite, shows `src/` in the repo structure, and dead-links
  `docs/build-ai-coworker.md` (now in `docs/done/`). Actual `pnpm dev` runs
  API :5454 + admin :5455.
- `CLAUDE.md:206` ("Legacy single-user server lives in `src/`"), `:757`
  ("being deleted"), `:849-851` (MDNS section describing the deleted runtime),
  and the Tech-list MDNS bullet (`:384`) — a capability with **zero hits** for
  `bonjour|mdns|_nessie._tcp|4317` across `api/`, `worker/`, `packages/`.
  `AGENTS.md:119-120` ("Legacy code lives in `src/`…").
- `CLAUDE.md` cites `docs/done/phase2-gcp-deployment-spec.md` but the file
  sits at `docs/phase2-gcp-deployment-spec.md`, still bannered "target-state
  design" — a retired topology violating the repo's own rule.
- `CLAUDE.md`/`AGENTS.md` pin the vendored billing protocol to UOA commit
  `272e4d95…`, but `packages/billing-statement-protocol.upstream.sha256` pins
  `698765f` — re-synced without the same-turn doc update.
- `macos/` (untouched since 2026-04-07) defaults `NessieClient.swift:191` to
  `http://127.0.0.1:4317` — its backend no longer exists; the CLAUDE.md claim
  "SwiftLint … warning treated as error in CI" is false (no Swift job in
  `.github/workflows/`).

Six further docs reference deleted `src/` files without historical banners
(`functionality.md` header framing, `corporate-usability-assessment.md`,
`manual-test-script.md:348`, `ob1-memory-concepts-for-nessie.md`,
`agent-base-template.md` §legacy, `review-findings.md` — still linked from
README as "Validated Findings"), plus `video-calling.md`'s 5554 local-stack
diagram. By contrast, 41 spot-checked CLAUDE.md/AGENTS.md file-path and value
claims (ports, constants, `EMBEDDING_DIMENSIONS`, tool-limit defaults) all
passed — the operational content is accurate; drift concentrates in the
legacy-era remnants.

**Fix.** Rewrite README against the current platform; delete the
legacy-`src/` and MDNS sections; move the GCP spec to `docs/done/`; correct
the vendored-commit hash; banner or retire the six stale docs; archive or
explicitly re-scope `macos/`.

**Impact: high (README is the front door; CLAUDE/AGENTS feed every agent
session). Effort: small — quick win.**

### 6. Client wire-contract types are duplicated and have already drifted

**Evidence.** `packages/client-core/src/api-types.ts` (511 lines) hand-writes
`ChannelRecord` (L28), `AgentRecord` (L103), `AgentTriggerRecord` (L352)
while `packages/schemas/src/workspace-records.ts` holds the authoritative zod
schemas. They differ **today**, in both directions: client-core has
`metadata?: ChannelMetadataRecord` and `ownerUserId` (L23, L120) which the
schemas lack; the schemas have `routingProfileId`
(`workspace-records.ts:114`) and required-nullable `lastMessageAt` (L56)
where client-core has neither. CLAUDE.md states these records "moved to
`@nessie/schemas`" — the move is half-done: admin consumes client-core's copy
via `admin/src/lib/api-client.ts` re-exports, the api emits the schemas'
shape. Two adjacent instances of the same disease:
`packages/connectors/src/types.ts:5` carries a TODO to adopt
`schemas/src/tools.ts` "once published" — it is published, and the mirrored
enums have begun diverging; and several admin facades hand-copy unpackaged api
contracts (`facades/alerts/hooks.ts:8-24` restates
`api/src/contracts/alerts.ts` field-for-field; `facades/runs/hooks.ts:4-16`
restates `ActiveRunSummary` with an already-softer status union) because
`api/src/contracts` is not importable from the browser.

**Fix.** Make `client-core/api-types.ts` re-export / `z.infer` the schemas
types and delete the duplicates; execute the connectors TODO; continue
graduating client-consumed api contracts into `@nessie/schemas`.

**Impact: high (silent contract divergence, live in three places).
Effort: small–medium.**

---

## Priority 2 — medium impact

### 7. `document_read` serves the vendor repo's own `docs/` tree to tenant agents

**Evidence.** `worker/src/run/content-tools.ts:23-25` resolves
`repoRoot/docs` from `import.meta.url`; the live `document_read` builtin ranks
and reads markdown files from it. The production image is `COPY . .`
(`infrastructure/docker/Dockerfile.app:25`), so every org's agents can read
Nessie's internal design docs in production. **Fix.** Retire `document_read`
or repoint it at the org's Knowledge Base; if repo docs are meant to be
agent-visible, decide that in writing. **Impact: medium-high. Effort: small.**

### 8. Dead code embodying the forbidden keyword-intent pattern

**Evidence.** `worker/src/run/content-tools.ts:229-236` exports
`shouldUseDocumentRead` / `shouldUseWebSearch` / `shouldUseWebFetch` — literal
trigger-word regexes over prompt content, the pattern AGENTS.md forbids. Zero
callers repo-wide; `run/tools.ts` re-exports them for importers that do not
exist; an OpenClaw-parity plan already ordered their removal. (The *live*
`selectDocumentPath` ranks files against the tool's explicit query argument —
lexical file search after the model chose the tool, not intent detection; see
Appendix A for the reviewer disagreement.) Related borderline case:
`worker/src/run/execute/memory.ts:33-82` decides "was this memory referenced"
by n-gram overlap — verbatim-quote detection that fails on paraphrase or
translation; either re-document it as quote-detection or route it through the
utility model (the `watch-status-gate.ts` precedent). **Fix.** Delete the
three functions and the re-export block. **Impact: medium. Effort: trivial —
quick win.**

### 9. Composition roots do work at import time and have absorbed wiring

**Evidence.** `worker/src/index.ts` (670 lines): `loadConfig()`, a
conditional **mutation of `process.env.DATABASE_URL`**, and
`getPrismaClient(...)` run at module top level (L86-95) — on
`import('@nessie/worker')` in embedded mode, import order silently decides
which DATABASE_URL wins. The rest is ~20 inline `queueProvider.subscribe`
closures. `api/src/index.ts` (532): parses `.env` and mutates `process.env`
at module top (L6-17), constructs the server context (config, Prisma, rate
limiter) at module scope (L119), kept importable-with-side-effects by a dead
re-export (`createCorsOriginChecker`, L117 — its only consumer imports from
`lib/server-context.js` directly). **Fix.** Move context/config creation
inside `startWorker()`/`startApiServer()`; extract per-domain
`registerXJobs(deps)` modules; drop the dead re-export. **Impact: medium.
Effort: small–medium, mechanical.**

### 10. Layering inversions: services importing routes, transport types in services

**Evidence.** `api/src/services/executor-fresh-verification.ts:3` imports
`FastifyReply`/`FastifyRequest` and sends HTTP errors itself; at L8 it imports
`guardAuthRequest`/`RATE_LIMIT_BUCKETS` **from `../routes/`** — the only
services→routes import in the tree. `services/designer.ts:12,304-315` writes
SSE straight to `reply.raw` (with a comment noting it bypasses
`@fastify/cors`). Naming hazard: same-named `lib/rate-limit.ts` (in-memory
per-IP) vs `services/rate-limit.ts` (pg-backed brute-force windows). **Fix.**
Move the auth-rate-limit primitives into a shared lib module; have the
verification service return a typed verdict; put SSE framing behind an
injected writer; rename one rate-limit module. **Impact: medium.
Effort: small.**

### 11. Workspace-boundary leaks: declared api→worker dependency; tests deep-importing sibling apps

**Evidence.** `api/package.json:41` declares `@nessie/worker` (embedded local
mode, `api/src/index.ts:514`) — documented behaviour, but an app→app edge
recorded nowhere as an accepted deviation. Sharper:
`api/test/scheduled-trigger-origin.test.ts:12` imports
`../../worker/src/control/trigger-run.js` and
`api/test/integration-query-keys.test.ts:11` imports
`../../admin/src/facades/integration-query-keys.js` — undeclared,
export-map-bypassing, invisible to Turbo's `^build`, the latter pulling
frontend source into a node test tree. These are the *only* deep imports
repo-wide. **Fix.** Record the embedded-worker edge in
`docs/architecture.md`; move the shared logic into packages or relocate the
tests. **Impact: medium. Effort: small.**

### 12. Retired-GCP code paths still live and config-reachable

**Evidence.** `packages/runtime/src/pubsub-queue.ts`, `gcs-storage.ts`,
`storage/gcs.ts` exported from the barrel; `packages/config/src/index.ts:33`
still offers `'pubsub'` queue and `'gcs'` storage; `worker/src/index.ts:115`
branches on `pubsub`; `infrastructure/terraform/` appears GCP-era. Docs say
GCP is retired; production is pg-queue + MinIO. **Fix.** Document as
supported alternatives or delete per "no fallbacks unless required".
**Impact: medium. Effort: small–medium.**

### 13. Theming rule violated; the workflow designer is hard-coded light-only

**Evidence.** `admin/src/lib/workflow-designer/constants.ts:6-65` bakes a
light palette into class strings (`bg-white`, `text-[#433349]`,
`hover:bg-[#f4eff8]`, per-node-kind hex); `WorkflowSamplePicker.tsx:22-143`
and `WorkflowNodeInspector.tsx:54` use Tailwind named colors;
`ExecutorsPage.tsx:33-35` uses `text-emerald-600`/`text-amber-600` where
`--success`/`--warning-text` tokens exist; `IntegrationsPage.tsx:103-107`
returns raw hex per product slug (while `deepsignal` already uses
`var(--accent)`, proving the token path); `ColoursPanel.tsx:4-16` hand-copies
each theme's swatch hex out of `styles.css`, so theme tuning silently stales
the picker; `ConversationBackButton.tsx:26` has the codebase's only `dark:`
variant, which tracks `prefers-color-scheme` rather than `[data-theme]`.
Against 2,500+ token usages elsewhere, compliance is otherwise excellent —
but on the 8 dark themes the designer renders light islands with wrong
contrast. (`lib/avatar.ts` gradients are identity colors — data, not theme
surface — judged legitimate; see Appendix A.) **Fix.** Introduce node-kind
tokens in `styles.css`; swap named colors for semantic tokens; render
ColoursPanel swatches inside `data-theme` wrappers; add an ESLint ban on
Tailwind named-color classes in `admin/src`. **Impact: medium. Effort: small
— quick win.**

### 14. Rule-zero duplication and facade bypass inside admin

**Evidence.** `components/features/agents/AgentDetailDrawer.tsx` (101 lines)
vs `AgentDetailColumn.tsx` (95) — the same agent-detail view implemented
twice, including a byte-identical `getStatusTone` (L16 vs L17), differing
only in chrome. `formatRelativeTime` exists **five times**
(`workflows/presentation.tsx:25`, `triggers/trigger-presentation.ts:42`
near-identical; `shared/AlertRow.tsx:3`; `dashboards/widget-format.ts:115`;
`projects/project-dashboard-data.ts:84`), and
`thread-panel/ReplySummaryBar.tsx:32` already reaches across features to
borrow one copy. Separately, an ops-page cluster bypasses the facade layer
entirely: `OperationalTelemetryPage.tsx:13-115`, `PolicyPage.tsx:39-63`,
`ApprovalsPage.tsx:58-64`, `AuditLogPage.tsx:30`, `OpsHealthPage.tsx:57-60`,
plus `BudgetManager.tsx`/`PricingManager.tsx` run inline
`useQuery`/`useMutation` with hand-declared DTOs and ad-hoc string query keys
that external invalidation can't reach. (Counterexamples done right:
`ChannelMessageFeed`, `KnowledgeWorkspace`, `DeepWaterRunHistory` are all
shared across surfaces per rule zero.) **Fix.** One `AgentDetail` with a
variant prop; one `lib/relative-time.ts`; move the ops cluster into
`facades/ledger|policy|approvals|ops`. **Impact: medium. Effort: small–medium.**

### 15. Five workspaces invisible to the architecture map; one dead file in `web/`

**Evidence.** CLAUDE.md's Architecture section lists
API/Worker/Admin/Web/Packages; `gateway` (deployed push relay —
`docker-compose.prod.yml:215`), `executor` (active, security-sensitive:
egress policy, VM sandboxing), `cli`, `desktop`, `mobile` are absent — three
of them the most actively developed dirs in the repo. Coverage gaps go with
it: `desktop` has no `build` task anywhere (CI compiles nothing of it beyond
lint/typecheck), `cli` has zero tests despite a super-admin-capable bin. And
`web/src/Workflow.tsx` (323 lines) is dead legacy UI calling the deleted
`src/` server's `/workflow` endpoint — imported by nothing, linted in every
CI run. **Fix.** One line per workspace in CLAUDE.md + pointers to existing
docs; delete `web/src/Workflow.tsx`; decide desktop/cli CI coverage
deliberately. **Impact: medium. Effort: trivial–small — quick win.**

### 16. The 500-line cap: 25 breaches, and no mechanical enforcement

**Evidence.** Non-test breaches (verified `wc -l`): workflows tier (finding
4: 1,989 / 1,180 / 673 / 598), `api/src/services/inference-control-plane.ts`
938 (four sub-domains), `cli/src/local.ts` 898 (missed by the primary sweep;
flagged by Sol, verified), `packages/schemas/src/executor.ts` 804,
`packages/knowledge/src/native-provider.ts` 729, `worker/src/index.ts` 670,
`api/src/services/messages.ts` 627 (cohesive — lowest priority),
`api/src/routes/agents.ts` 614, `api/src/routes/knowledge-base-files.ts` 607,
`api/src/routes/executors.ts` 606,
`packages/executor-manage/src/executor-commands.ts` 591,
`worker/src/run/execute/run-job.ts` 564, `executor/src/sandbox-workspace.ts`
559, `api/src/routes/knowledge-base.ts` 550, `api/src/index.ts` 532,
`packages/config/src/index.ts` 522 (the entire package is one file),
`api/src/services/policy.ts` 519, `packages/client-core/src/api-types.ts` 511
(≈0 after finding 6), `api/src/lib/server-context.ts` 508,
`admin/src/pages/ChannelsPage.tsx` 503,
`packages/executor-manage/src/executor-records.ts` 502. The cap is
convention-only: `eslint.config.js` has `max-len` but **no `max-lines`
rule**. Notable structural case: `run-job.ts` threads the DeepWater-handoff
concern through ~8 independent exit paths — fold it into the existing
`DeepWaterHandoffGuard` so the orchestrator is handoff-blind at exits.
**Fix.** Add `'max-lines': ['error', {max: 500}]` with the current list
grandfathered per-file; split along the seams named above when next touched.
**Impact: medium. Effort: medium, amortizable; the lint rule is a quick win.**

---

## Addendum — security-boundary findings (Codex Sol pass, verified)

Sol's independent pass went deeper on trust boundaries than the structural
brief asked for. Every finding below was **re-verified against the tree**
(load-bearing lines confirmed verbatim) before inclusion; they are
architectural in the sense that each is a good primitive that exists in-repo
but is an optional convention rather than an unavoidable boundary. Sol's
framing: "the first four should block a production security sign-off."

- **S1 — Session tuples can cross tenants.** `session-issuers.ts:30-56` loads
  org/project/team memberships independently and combines element zero of each
  list with no `project → organization` / `team → project` hierarchy check;
  refresh rebuilds the tuple the same way, and `RefreshToken` stores no
  selected project/team. `POST /api/users` then writes `OrganizationMember` +
  `ProjectMember` + `TeamMember` from that ambient tuple without hierarchy
  validation in the transaction. *Fix:* one authoritative
  `resolveSessionContext` that verifies the hierarchy before issuance, bound
  to the refresh family; revalidate in membership writers. (High; larger
  refactor.)
- **S2 — Owners can bind arbitrary `process.env` names as inference
  credentials.** The public contract accepts any non-empty `authSecretRef`
  (`api/src/contracts/inference-control-plane.ts:97`) and the worker resolves
  it as `process.env[authSecretRef]`
  (`worker/src/run/inference-provider.ts:79-80`) — so `DATABASE_URL` can be
  sent as a Bearer token to an owner-controlled endpoint. A deployment-wide
  Ledger base URL suppresses the binding; self-hosted/multi-tenant remains
  exposed. The MCP secret-resolver's exact allowlist is the in-repo correct
  pattern. *Fix:* remove caller-chosen env refs; encrypted opaque refs only,
  as MCP already does. (High; medium effort.)
- **S3 — Inference connectors dial unpinned.** Provider URLs are
  SSRF-validated at write time, but the connectors use raw `fetch` at runtime
  (`packages/runtime/src/inference/connectors/openai.ts:64,86,135,190`; kimi,
  minimax likewise) — the exact validate-then-dial gap the egress rule names.
  Extends finding 2's family to the model-call path itself. *Fix:* injectable
  pinned fetch in the connector interface, `maxRedirects: 0` for credentialed
  calls. (High; medium.)
- **S4 — `safeFetch` replays origin-bound credentials across redirects.** The
  manual redirect loop passes the original `init` (headers and body) to every
  hop (`packages/runtime/src/url-safety.ts` redirect path), and manual
  following means native cross-origin credential-stripping never applies; the
  `http_fetch` one-hop redirect repeats the pattern. A legitimate MCP host can
  redirect its bearer to another origin. `packages/dashboard/src/source-fetch.ts`
  (`maxRedirects: 0`) is the in-repo correct precedent. *Fix:* centralize
  redirect policy — same-origin or refuse for credentialed requests; strip
  auth headers on permitted cross-origin hops. (High; medium.)
- **S5 — Any channel member can add/remove members.** Both mutation routes
  gate only on `getChannelIfMember` (`api/src/routes/channels.ts:349+`) and
  the service takes no actor (`channel-members.ts` — it does block cross-org
  targets, but has no manager gate, no policy check, no audit). The manager
  rule (`canManageChannel`) exists and is unused here; the admin UI shows "Add
  people" to owners only, masking the gap. (High; quick–medium.)
- **S6 — Run lifecycle is org-wide, including private-channel and PA runs.**
  List/cancel/restart check only `thread.channel.organizationId`
  (`api/src/services/run-access.ts:35`, `runs.ts` routes carry only
  `requireActorContext`), letting any org member enumerate and kill runs in
  channels they cannot see; `continueRun` already does the correct
  `findThreadForUser` check. *Fix:* `loadRunForActor` with channel entitlement
  + PA ownership, used by all four verbs. (High; medium.)
- **S7 — Thread SSE authorizes only at connect.** `ThreadSseConnection`
  stores no user/org identity (`api/src/realtime/hub.ts:17-28`) and fan-out
  matches by `threadId` alone, so a revoked member's open stream keeps
  receiving messages/reasoning/documents until it disconnects — while user
  SSE/WS run `canAccessChannelEvent` per event. *Fix:* store identity on the
  connection and check per event, or disconnect on revocation. (High; medium.)
- **S8 — Web Push delivery is check-then-fetch.** `web-push-delivery.ts`
  re-validates with `assertSafeUrl`, then `packages/push/src/webpush.ts:40`
  dials raw global `fetch` (fresh DNS, follows redirects) — rebind/redirect
  SSRF from the worker on member-registered endpoints. *Fix:* pinned fetch at
  the socket boundary, `maxRedirects: 0`. (High; medium.) *(Corrects the
  Kimix-era "Web Push is handled correctly" note in "notably healthy," which
  described the validation but not the dial.)*
- **S9 — Targeted session revocation leaves access JWTs live.** "Revoke
  session" and password change revoke refresh families only
  (`refresh-session-management.ts:120`); central auth checks only the
  user-wide `tokenVersion` (`server-context.ts:276-281`), so a revoked
  session's ~30-minute access token keeps working. Logout already bumps
  `tokenVersion` — the targeted paths do not. (High; medium.)
- **S10 — pa-tools channel authz also ignores deactivation.** The forked
  `canManageChannel` in `pa-tools/channels.ts` contains no `deactivatedAt`
  check (the correct `resolveActingMember` in `pa-tools/access.ts:80-82`
  does), so a deactivated user's queued PA work retains channel authority.
  Strengthens finding 1: the fork is not just drift-prone, it has already
  drifted on a security property. (Folds into finding 1's fix.)
- **S11 — Worker tool-policy copy fails open.** The canonical evaluator in
  `@nessie/workspace-admin` denies when no rule matches;
  `worker/src/run/execute/policy.ts` returns
  `{allowed: true, policySource: 'none'}` on no match. Not exploitable today
  (the registry/grant gate runs first), but two opposite defaults for one
  security decision is a latent bypass. *Fix:* one shared evaluator; if tools
  intentionally default-allow, encode that as an explicit mode. (Medium;
  quick.)
- **S12 — Forwarded-header parsing bypasses proxy trust.** MCP OAuth and
  comms callback construction read `x-forwarded-proto`/`x-forwarded-host`
  directly from headers (`api/src/routes/mcp/oauth.ts:58-62`,
  `comms/oauth-config.ts:101-105`) instead of Fastify's trusted-proxy-scoped
  values — the exact pattern `docs/architecture.md` forbids. *Fix:* one shared
  callback-URL helper over `request.protocol`/hostname. (Medium; quick.)
- **S13 — The encrypted secret table has no tenant/purpose at its decrypt
  boundary.** `McpOAuthSecret` is ref+ciphertext only
  (`api/prisma/schema.prisma:4115-4123`) yet now stores MCP OAuth tokens,
  platform push credentials, and dashboard credentials; the resolver decrypts
  any `secret_*` ref with no expected-scope argument, and push duplicates the
  store implementation. *Fix:* purpose-named store with required
  tenant/owner/purpose columns; scope-checked resolve/delete. (Medium; larger.)
- **S14 — The duplicated api inference contracts have diverged from schemas.**
  `api/src/contracts/inference-core.ts:98` accepts any non-empty `imageUrl`
  where `packages/schemas/src/inference-core.ts:58` requires `.url()`, and the
  api copy omits `reasoning_text.delta` from the stream union — a live
  divergence in *validation strength*, extending finding 6 beyond client-core.
  (Medium; small.)

Sol also confirmed independently: `document_read` doc exposure (finding 7),
the dead intent helpers (finding 8), the comms-route workflow and worker
composition-root side effects (findings 3, 9), the ops-pages facade bypass and
workflow-designer theming (findings 13, 14), dead `web/src/Workflow.tsx`, and
the clean workspace dependency graph. New hygiene: tracked
`api/.dash-storage/` runtime data and two tracked `.playwright-mcp/` logs
(verified); admin/web ESLint loads no `react-hooks` rules while mobile's does;
and the inference control plane has no admin surface at all (routes registered,
zero admin references — a live rule-zero violation with its surface already
designed in `docs/plans/2026-08-11-unsurfaced-capabilities.md`).

---

## Priority 3 — hygiene, naming, conventions

| Finding | Evidence | Fix |
| --- | --- | --- |
| ~70 MB local root clutter | 115 untracked root PNGs (23 MB), `tmp/` 39 MB, root `dist/` = 2.7 MB **build fossils of the deleted `src/`**, `output/` 5.9 MB (dir not gitignored — only clean because `*.png` matches) | Delete all; add `output/` to `.gitignore` |
| Blanket `*.png` gitignore | Every legitimate icon/asset needs `git add -f`; deploy.yml already assumes root-only exclusion | Narrow to `/*.png` + `/admin/*.png` |
| `archive/mobile-native/` | 24 tracked files of the superseded Expo app, inert, still referencing `@nessie/client-core`; git history preserves it | Delete (repo precedent: `src/`) |
| Three unowned test-ish dirs | `e2e/` = manual log + screenshots citing retired ports; `testing/openclaw/` dormant since April; `simulation/` live-ish but README-less; none referenced by any script/CI | Move `e2e/` to `docs/done/`, delete `testing/openclaw/`, give `simulation/` a README + script or archive |
| Stray root dirs | `UI/` (2 planning stubs), `memory/triage-log.md` (name-collides with memory packages), `remote/` (Go control plane, README says "Helper project", outside all build/CI), `assets/` (2 icon masters) | Fold into `docs/`/`docs/done/`, archive `remote/` or fix its README, move icons under consumers |
| ~~Root `pnpm lint` was red on main~~ | Resolved 2026-08-13: the two plans that exceeded the 1,000-line limit now use the prescribed `<name>/overview.md` plus focused chapter files. | Keep future additions in the focused chapters rather than rebuilding one oversized file. |
| `docs/plans/` housekeeping | Multi-file plan directories are the *sanctioned* shape (the lint prescribes them >1,000 lines), but `2026-08-11-executor-integration/` coexists with its same-named `.md` (a partial split), and ~9 shipped plan-specs cited from CLAUDE.md as authoritative were never moved to `docs/done/` (nothing has moved since 2026-07-25) | Finish the partial split; sweep shipped plans or amend the rule — rule and practice currently contradict |
| `knowledge-*` route sprawl | 11 flat `knowledge-*.ts` files in `api/src/routes` — "a directory that was never made" while `workflows/` and `mcp/` got theirs | Fold into `routes/knowledge/` |
| Forbidden "helpers" naming | `api/src/services/contract-helpers.ts` (generic JSON coercions); `api/src/lib/request-helpers.ts` (486 lines — cohesive entitlement/visibility module, misnamed); `lib/api.ts` vague; admin: `channel-helpers.ts`, `thread-panel-helpers.ts`, `document-stream-helpers.ts`, `settings-shared.tsx`, `workflows/presentation.tsx` (grab-bag already leaking across features) | Inline/rename (`entitlements.ts`, `api-envelope.ts`, split `presentation.tsx`) |
| Single-consumer packages | `@nessie/dashboard` (api-only, weakest case), `@nessie/connectors` (api-only; shrinks after finding 6); `web`+`admin` declare `@nessie/config`/`schemas` they never import | Fold into api or record intended second consumer; remove unused declared deps |
| `@nessie/workspace-admin` has no test script | The package whose contract is "mirrors route authorization exactly" is covered only indirectly | Add a unit suite for the pure gates |
| Two `queue_jobs` INSERT implementations | `runtime/src/queue.ts` (pg Pool) vs `db/src/queue.ts` (Prisma, in-transaction — deliberate) duplicate column list/defaults | Extract one shared SQL-text builder |
| Naming/test placement drift | `worker/src/run/channel-tools.test.ts` tests `pa-tools/channels.ts` from the wrong dir under a name matching no source; `runAgenticLoop` has two test homes; `facades/agents/keys.ts` contains no keys (it's realtime state); five kebab-case files in `mcp-app-store/` export PascalCase components; api contract barrel used by 71 files but silently omits three areas | Move/rename; pick barrel-or-direct and complete it |
| Dead exports/files | `api/src/services/policy.ts:28` `checkPolicyBatch` (no callers); the api index CORS re-export (finding 9); `admin/src/components/shared/ToolCategoryIcon.tsx` (unimported) | Delete |
| `@nessie/runtime` trending toward a common bucket | 69 files, ≥10 concerns; membership test has become "shared by api+worker". Coherent clusters ready to graduate: Ledger/UOA identity (~5 files ≈1,800 lines), DeepWater handoff state | Advisory: extract the two clusters when next touched |
| CLAUDE.md/AGENTS.md dual maintenance | CLAUDE.md embeds AGENTS.md (`@./AGENTS.md`) yet both restate overlapping standards (~1,400 diff lines), doubling drift chances (the vendor-hash and legacy-`src/` drift hit both) | Push shared standards into AGENTS.md; keep CLAUDE.md additive |

## What is notably healthy (verified)

- **Dependency graph:** no cycles, no package→app edges, zero deep-path
  `@nessie/x/src` imports (outside the two test files in finding 11); uniform
  tsconfig/NodeNext/composite discipline; the comms and mcp package families
  are textbook layering. Confirmed independently by the packages pass and
  Kimix.
- **Credential-at-rest crypto is centralized:** one AES-256-GCM primitive set
  (`runtime/src/secret-crypto.ts`) reused by every store — no duplication.
  FCM/APNs egress is pinned (`safeFcmFetch`, fixed APNs host); Web Push
  *validation* is done at send time but its dial is not pinned — see S8.
- **The agentic loop is genuinely orchestration-over-collaborators:**
  `run/agentic-loop.ts` is a pure loop (no Prisma; effects behind injected
  callbacks); the 57-file `execute/` directory is fine-grained, one decision
  per well-named file.
- **The reuse rule works where applied:** api services re-export
  `@nessie/workspace-admin`; worker provisioning uses it and
  `@nessie/mcp-manage`; all worker byte access goes through the one
  `FileService`; `safeFetch` has exactly one implementation.
- **api conventions:** 100% kebab-case, contracts genuinely split by area
  (largest 406 lines), one TODO in the whole tree, zod validation in 63/78
  route files, consistent test harness/fixture naming; route auth guards
  uniformly applied.
- **admin structure:** facades/components/providers layering is consistent
  and react-query-uniform; dead code is near-zero; deliberate browser-side
  constant mirrors are documented and drift-gated by tests.
- Only 23 of ~1,300 source files breach the size cap; the intent rule
  (model-judged, never string-matched) is respected everywhere live.

## Ranked summary (impact × effort)

| # | Finding | Impact | Effort | Class |
| --- | --- | --- | --- | --- |
| 5 | Doc drift: README, legacy-`src/`/MDNS, GCP spec, vendor hash | High | Small | Quick win |
| 2 | OIDC/UOA login egress outside the pinned chokepoint | High | Small (OIDC fix) | Targeted fix |
| 1 | pa-tools channel authz fork | High | Small–Med | Targeted fix |
| 6 | Drifted duplicate wire contracts (client-core, connectors, facades) | High | Small–Med | Quick win |
| 3 | Routes bypassing services (32 files; comms OAuth in route) | High | Medium | Ratchet |
| 4 | Workflows subsystem oversize + naming in all tiers | High | Large | Refactor |
| 7 | `document_read` exposes vendor docs to tenants | Med-High | Small | Targeted fix |
| 8 | Dead forbidden keyword-intent exports | Medium | Trivial | Quick win |
| 13 | Theming: light-only workflow designer + named colors | Medium | Small | Quick win |
| 15 | Undocumented workspaces; dead `web/src/Workflow.tsx` | Medium | Small | Quick win |
| 14 | Admin rule-zero duplication + ops facade bypass | Medium | Small–Med | Cleanup |
| 9 | Import-time side effects + bloated composition roots | Medium | Small–Med | Cleanup |
| 10 | services→routes inversion; transport in services | Medium | Small | Cleanup |
| 11 | api→worker edge undocumented; tests deep-importing apps | Medium | Small | Cleanup |
| 12 | Retired GCP paths config-reachable | Medium | Small–Med | Decision |
| 16 | 500-line-cap ratchet (25 files, no `max-lines` rule) | Medium | Medium | Ratchet |
| S1–S4 | Session tenant tuple; env-ref credentials; unpinned inference; redirect credential replay | High | Medium–Large | Security fixes |
| S5–S9 | Channel-member mutation; org-wide run lifecycle; SSE connect-only auth; Web Push dial; revocation gap | High | Small–Med | Security fixes |
| S10–S14 | Deactivation gap in the pa-tools fork; fail-open policy copy; forwarded headers; secret-store scoping; api contract divergence | Medium | Small–Large | Security fixes |
| — | P3 hygiene table | Low | Trivial–Small | Sweep |

Suggested order: (1) the doc-drift quick wins (5, 15) — they poison every
future agent session; (2) the three targeted security/contract fixes (2, 1,
6) — small, and the drift is live; (3) land the two lint ratchets (3, 16)
plus the trivial deletions (8, 13, hygiene sweep); (4) schedule the workflows
refactor (4) and the `document_read`/GCP decisions (7, 12) as tracked tasks.

---

## Appendix A — reviewer status, agreements, disagreements

**Complete and folded in** (every high-severity claim re-verified against the
tree before acceptance): primary audit; api, worker, admin,
packages/dependency-graph, peripheral/hygiene, docs-drift area passes;
**Kimix** and **Codex Sol** external reviews.

**On Sol:** its pass went deepest on trust boundaries (Addendum). Nineteen of
its claims were sampled for direct verification — session-issuer tuple
construction, `process.env[authSecretRef]`, four raw-`fetch` connector sites,
the `safeFetch` redirect `init` reuse, channel-member route guards,
run-access org-only filter, `ThreadSseConnection` shape, web-push raw fetch,
`tokenVersion`-only revocation, the fail-open worker policy default, the
missing `deactivatedAt` check, forwarded-header parsing, `McpOAuthSecret`
columns, `imageUrl` contract divergence, `cli/src/local.ts` 898 lines,
tracked `.dash-storage`/`.playwright-mcp` files, the react-hooks lint gap,
and the surfaceless inference control plane — **all nineteen confirmed
verbatim**; no sampled claim failed. Sol avoided both of Kimix's factual
errors (it did not call gateway orphaned, and it correctly identified the
intent-regex exports as dead).

**Agreements (independent convergence):** workflows oversize (primary + api +
worker passes + Kimix); comms-connections route violation (api pass + Kimix);
worker index wiring monolith (worker pass + Kimix); `designer.ts` raw-SSE
transport leak (api pass + Kimix); Executors/workflow-designer theming
violations (admin pass + Kimix); dependency-direction cleanliness, secret-
crypto centralization, and the documented api→worker embedded edge (packages
pass + Kimix); client-core DTO drift (packages + admin passes, disjoint
drifted fields, both verified).

**Disagreements, with resolutions:**

- *Gateway "orphaned, no production wiring" (Kimix G2)* — **rejected**:
  `nessie-gateway` is built and deployed in
  `infrastructure/compose/docker-compose.prod.yml:215-220`; Kimix quoted a
  stale README sentence. (The README staleness itself is worth fixing.)
- *`content-tools.ts` live keyword intent detection (Kimix E1, "HIGH")* —
  **downgraded**: `shouldUse*` have zero callers (dead code, finding 8);
  live `selectDocumentPath` ranks files against the tool's explicit query
  argument after the model chose to call it — lexical search, not intent
  gating. The worker pass's reading was confirmed by call-site inspection.
- *`routes/workflows.ts` shim as "split to satisfy the limit" (Kimix C)* —
  **rejected**: the `workflows/{templates,installations,runs}` directory is a
  cohesive domain split with a registrar, i.e. the sanctioned shape — and the
  model the oversized *service* tier should follow.
- *`avatar.ts` gradients as theming violations (Kimix F1)* — **rejected**
  (siding with the admin pass): stable per-identity colors are data, not
  theme surface; they must not change with the theme.
- *`docs/deployment.md` references retired port 5555 (Kimix H3)* —
  **rejected**: no `5555` occurrences in that file; the stale-port hits are
  in `corporate-usability-assessment.md` (already flagged) and
  `video-calling.md`'s diagram.

Kimix's genuinely new contributions, verified and adopted: finding 2 (OIDC
discovery/token/userinfo bare-fetch + missing issuer-origin pinning; UOA
session fetches), the `executor/src/sandbox-workspace.ts` cap breach, the
`knowledge-*` route-directory observation, and the IdP-trust-anchor
plaintext-config asymmetry (noted inside finding 2's fix).
