# Delivery and verification

Part of [Local Ollama agents](overview.md).

## One coherent release

The steps below are implementation phases inside one feature branch and
release gate. Intermediate commits may be reviewed, but an API-only slice is
not a delivered capability. Keep the feature disabled until both host modes,
all required surfaces, revocation and the verification matrix are complete.
The requested review sequence is design → Sol adversarial review → Terra
implementation → independent root verification → green PR merge → production
promotion. No implementation or deployment is performed by this design commit.

### Phase 1 — contracts, authority and storage

Add the schemas, migrations and live authority service, including every
protected-key write path. Use existing run/model selection as the seam, not a
second generic provider registry. Add a discriminated run inference lane before
any new dispatch branch. Introduce the closed `ProvenancedProviderInput`, the
tri-state UOA decision, organisation policy-version serialization and Save-only
activation before a local prompt can be built. Produce a reviewed authority/
precedence test matrix and the complete new schema; feature remains off.

### Phase 2 — shared host and server inference delivery

Extract/reuse canonical daemon authentication and loopback Ollama transport;
build typed attempts, receipts, cancellation, expiry and bounded streaming.
Integrate executor transport and the inference-only Desktop bridge from the
same host package. Use recorded fake Ollama HTTP responses and real
loopback sockets, including malformed/slow servers. No shell or model downloads.
Complete native packaging/signing/secure-storage integration on all three OSes.

### Phase 3 — agent lane and complete experience

Wire the selected local provider through main/utility/delegate invocation,
metering, budgets, full-source disclosure checks, status and health alerts.
Build the shared setup, policy and availability components in their named
homes and doorways. Make direct and relay setup work end to end with existing
agents. Complete every UI/executor inventory row and remove additions lacking
a decision. Exercise the real installed Windows Ollama model only after the
user chooses/consents in the actual product flow.

### Phase 4 — release qualification and rollout

Implement the binding resolutions in `review-reconciliation.md`; the original
Sol verdict remains an audit artifact, not an unresolved implementation choice.
Independently review security, brief fulfilment/no extra UI, AI communication
and durable Playwright user flows. Execute the matrix below, including native
macOS/Linux evidence and Windows real Ollama. Publish signed client artifacts,
merge only after required CI and requested Browser Suites are green, then
promote/verify the exact trusted main SHA through the existing deployment
workflow. Missing native hosts/certificates or incomplete evidence is a named
release blocker, not a reason to label all platforms tested.

## Likely files and symbols

These paths exist at the inspected SHA unless marked **new**. Split cohesive
modules before reaching the 500-line code cap; route handlers parse/call/map
errors and do not acquire policy or inference workflow responsibilities.

| Area | Existing integration point | Proposed work |
| --- | --- | --- |
| Database | `api/prisma/schema.prisma`; `api/prisma/migrations/` | Add host/binding/challenge/attempt/frame models and lane/billing fields; additive immutable migration with tenant/unique/CHECK constraints. |
| Shared contracts | `packages/schemas/src/local-inference.ts`; `executor.ts`; `inference-core.ts` | **New** `local-agent-inference.ts` for observed inventory, pin, frames, presence and errors; keep curated download catalogue separate. Export only domain-owned contracts. |
| Server domain | `packages/executor-manage/src/executor-daemon.ts`, `executor-liveness.ts`, `executor-command-codec.ts` | **New** focused `@nessie/local-inference` service package for consent, authority, attempts and presence; extract shared signed machine-channel primitives before reuse. Reuse `encryptWithKeyRing`/`toEncryptionKeyRing`, adding authenticated associated context if the current wrapper lacks it. |
| Local runtime | `executor/src/ollama-client.ts`; `executor/src/daemon.ts`; `executor/src/state-store.ts`, `state-security.ts` | **New** `@nessie/local-inference-host` package for loopback discovery/chat, leases, receipts and local endpoint capacity; executor imports it. Retain importVerifiedModel and curated blob downloading at their existing home. Move the justified egress allowlist entry with the sole transport, do not duplicate it. |
| Direct desktop | `desktop/src-tauri/src/lib.rs`, `executor_companion.rs`; `desktop/src-tauri/capabilities/`; `desktop/scripts/` | **New** `local_inference.rs` supervisor with origin-checked commands/secure keys and inference-only packaged entry point. Do not create an Executor row or ask for a workspace. Update signed runtime manifest and packaging tests. |
| Local consent shells | `executor/menubar-macos/Sources/App/ExecutorController.swift`; `executor/tray-windows/src-tauri/src/commands.rs`; `executor/src/index.ts` | Thin local consent/pause/status/doorway adapters; same host schemas and Linux CLI verbs. No separate native model catalogue. |
| Entitlement | `packages/runtime/src/scoped-settings.ts`, `uoa-live-entitlements.ts`; `api/src/routes/scoped-settings.ts`; `api/src/contracts/scoped-settings.ts` | Register typed key-specific writers and admin-targeted user scope, resolving live UOA authority before all reads/writes. Preserve the single cascade/lock logic. |
| Agent mutation | `packages/team-admin/src/agent-model-selection.ts`, `agent-model-options.ts`, `agent-create.ts`, `agent-update.ts`, `agent-edit-authority.ts`; `api/src/routes/agent-delete.ts` | Third explicit lane in one validator/picker; binding consent; copy/import/transfer/delete audit and revocation; `canEditAgent`/private visibility remain authoritative. |
| Worker admission | `worker/src/run/execute/subscription-binding.ts`, `run-inference.ts`; `worker/src/run/inference-provider.ts` | **New** `inference-binding.ts` for `RunInferenceBinding`; extract existing subscription decision instead of adding parallel nullable arguments throughout the worker. |
| Worker dispatch | `worker/src/run/inference-stage.ts`, `inference.ts`, `inference-retry.ts`; `packages/runtime/src/inference/types.ts`, `service.ts` | Inject local transport service, normalized capabilities and deltas; preserve invocation ids, no cloud fallback, utility lane inheritance. |
| Run security/lifecycle | `worker/src/run/execute/disclosure-basis.ts`, prompt assembly adapters, `crash-checkpoint.ts`, `cancel-stop.ts`; `api/src/services/runs.ts`, `run-continuation.ts` | Add closed provenance tokens for every provider-input component plus full recipient check before dispatch; cancellation/lease fencing; resume exact pin; real authorized restart doorway for offline terminal failure. |
| API | `api/src/routes/executor-daemon-routes.ts`, `agents.ts`; route composition beside these | **New** `local-inference.ts`, `local-inference-daemon.ts` routes over the same domain functions; browser sessions never call machine routes as a substitute for signatures. |
| Usage/health | Existing `recordInferenceUsage`, `applyBudgetGate`, `UserAlert` pipeline and worker control sweeps | Structural local billing source, currency exclusion, token metering, reader-first typed local alert/resource authorization, exact recipients, bounded attempt/TTL sweeps under existing locks. |
| Frontend facade | `admin/src/facades/agents/`; `admin/src/facades/designer/`; settings/executor facades | **New** focused `facades/local-inference/hooks.ts` and `keys.ts`, shared response schemas, no new global context or raw per-page fetch. |
| Model home | `admin/src/components/features/agents/designer/ModelCombobox.tsx`, `AgentDesignerForm.tsx`, `ModelUnavailableNotice.tsx` | Compose the same local setup/status feature, add the real consumed `designerSection=model` value and explicit unavailable selection. |
| Presence | `admin/src/components/shared/AgentAvatar.tsx`, `UserAvatar.tsx`; `components/primitives/PresenceBadge.tsx`, `IdentityTile.tsx` | Shared badge geometry with separate agent availability facade; extend existing addressing rows/header, never the human presence table. |
| Management homes | `admin/src/pages/settings/ConnectionsPage.tsx`; `ExecutorDetailPage.tsx`; `components/features/settings/ScopedSettingGate.tsx` | Shared host controls and scoped enablement in existing Models, Members and Team surfaces. |
| Navigation | `admin/src/navigation/admin-surfaces.ts`, `router.tsx`, relevant facades/navigation hooks | Extend consumed anchors/query and cold-link tests; no duplicate sidebar destinations. |
| Documentation | This plan; model availability, subscriptions, executor, design-system, run budgets, capability health, egress, local state and running-the-apps guides | Record as-built differences, native requirements, new consent/billing contracts and limits; add one short routing signpost in `AGENTS.md`/`CLAUDE.md` when implementation lands. |

## Migration and mixed-version rollout

1. Expand schema with nullable local fields, reader support for every new enum/
   alert/resource reference, and no fabricated host/presence
   defaults. Existing agents keep their exact model lane. No inference of
   ownership, device, consent, model digest or team from names or session state.
2. Deploy consumers that understand the new lane to **all** workers before any
   API can write it. Readiness capability/version is a deployment fact checked
   at enablement; older workers must never claim a local run and treat it as
   Ledger. New run payloads carry a required-lane version and queue admission
   excludes consumers lacking it, or keep writes disabled until the rolling
   deployment fully drains old workers. Do not rely on a UI-only flag.
3. API and admin additions are optional/read-compatible while disabled. Keep
   `agent.updated` invalidation until listeners can parse the new event. Old
   native clients report “Update Nessie/Executor” and no local capability;
   missing heartbeat report is unknown, never false-empty or ready.
4. Only after every old API/admin/worker writer is fenced from mutating a local-
   pinned agent may writes be enabled. An old binary encountering the local lane
   returns explicit unsupported/unavailable and cannot clear it, deserialize it
   as Ledger, or apply a provider default. Add mixed-version contract tests.
5. Install signed host-capable client builds, then enable the deployment
   capability and grant a controlled person/team. Enabling per tenant remains
   false by default. Full production exposure requires all acceptance evidence.
6. Rollback is disable admission → fence/drain attempts → leave local agents
   explicitly unavailable. Keep the additive schema and consent/history; never
   downgrade them to default cloud models. A binary rollback to a version unable
   to parse local pins requires retiring/draining their queue before rollout.
   The rollback gate proves with persisted active bindings and queued attempts
   that no request moves to cloud or another device and no old writer erases the
   local selection.

Fresh and populated database upgrade paths must pass the checked-in baseline
fixture. Add partial indexes for active agent bindings and expiring attempts;
follow the migration standard for large existing tables and concurrent indexes.
Do not edit historical migrations. Old curated catalogue/download code remains
usable; this release never deletes or renames the user's installed models.

Production is the existing Hetzner stack, not a new inference server. No Ollama
container, public port, reverse tunnel or new cloud credential is deployed.
Before modifying packaging or deployment use
[build and release](../../standards/build-and-release.md) and
[redeploying](../../deployment/redeploying.md). Follow exact-SHA CI promotion;
verify the deployed API/admin build and a real hosted-to-local attempt after
promotion. Signed desktop/executor artifacts are a separate delivery: hosted
admin deployment alone cannot prove that native local inference is live.

## Verification matrix

Follow [testing](../../standards/testing.md): package tests through Turbo, with
`DATABASE_URL` explicitly exported for every Postgres run, worker-before-API
ordering, bounded process concurrency, isolated fixtures and no global cleanup.
Run required lint/typecheck/build/checks. Rebuild worker after worker changes.
Use `pnpm dev` and fixed per-worktree ports for browser verification; verify
API `/health`, admin `/` and `@vite/client` after starts. Do not replace HMR
with an admin production build to view changes.

| Layer | Durable cases / required evidence |
| --- | --- |
| Pure policy | All cascade table rows; org/team/person locks including lock-with-null; admin targeting another person; member forging raw scoped key; team-owned vs person-owned; destination team mismatch; unknown placement; no ambient-session narrowing. |
| Live authority | UOA team/org removal, demotion, epoch rotation; 401/403 denial distinct from 429/timeout/malformed/5xx unavailable; direct custodian and scheduled stored-identity paths; no new user/profile/member rows; unbound local tenant behaviour; private agent unreadable to org admin. |
| Database races | Cross-org FKs, one active binding, prepare/confirm/Save/cancel/expiry/policy-disable races on two replicas, concurrent claim, replayed challenge, stale epoch heartbeat/goodbye/result, duplicate sequence mismatch, exactly-once terminal usage, key rotation/delete/revoke during lease. |
| Loopback transport | IPv4/IPv6/saved/default endpoints with conflicting daemons and deterministic explicit choice; alternate local port, redirect rejection, public/LAN/metadata/rebinding refusal, slowloris, compressed/chunked aggregate caps, invalid UTF-8/control strings, proxy-env bypass, empty inventory distinct from failed scan. |
| Discovery | Already running Ollama on macOS/Windows/Linux; installed but stopped; service versus user account; WSL inaccessible from host; aliases; a real remote/cloud entry with `remote_host`/`remote_model` and observed outbound traffic; tag change, model removal, unsupported version; no automatic exec/pull/create/delete. |
| Provider contract | Ordinary answer; two tool-call rounds and tool results; structured output where supported; stream chunk boundaries; reasoning separation; output length/empty result; unsupported tools/media refusal; compaction and delegates stay local. |
| Disclosure | Public context; own private agent; all cross-person/team-owned hosts rejected; unknown/private-author lineage; tool adds restricted source mid-run; resumed checkpoint; one prompt adapter deliberately omits its coverage token and dispatch fails before any prompt byte is persisted/delivered. |
| Failures and lifecycle | App quit/crash/sleep, executor stop, Ollama crash, network partition, device clock skew, cancellation mid-stream, host resource failure, bounded queue overload and timeout, explicit model switch, no cloud call after local failure. |
| Multiple replicas/devices | Two APIs and workers; kill worker/API during stream; recover durable receipt without repeating tool effects; same host second process fences first; separate host never takes over silently; desktop+executor share capacity where OS identity permits. |
| Budgets/billing | Local usage has `local_device` and stable invocation id; null currency cost; organisation currency exhaustion does not route/block local generation; token/tool/time caps still stop; paid-tool gates remain; deployment utility/security calls accounted separately. |
| Health | One alert per episode/revision; correct repair recipient and deep link; no private agent/device leak; ordinary sleep quiet; revoked state not healed by login; repaired schedule not auto-replayed. |
| Native distribution | Signed macOS direct build, Windows MSI/NSIS, Linux package; main window vs document window, untrusted/custom origin, sign-out/relogin and stale challenge; no workspace/VM for direct mode; secure-store failure/rotation fences consent; no secret in argv/webview/log; app exit terminates bridge; executor remains independent. |
| Browser flows | New persistent headless suite in `admin/e2e/local-ollama-agents/`; scripts registered in `admin/package.json` and requested Browser Suites workflow; exact cases below with screenshots. |

Browser evaluations must drive genuine service boundaries using a scripted
Ollama server and a real host protocol client, not inject a ready dot directly
into React. Seed two users, two teams, a private and shared existing agent,
and a denied team. Required journeys:

- Admin enables one person, then a team; inherited lock refuses a raw API edit.
- Desktop detection → model choice → native consent fixture → save → same
  existing conversation receives a streamed answer and a native tool round.
- Relay setup from executor detail, local consent, then agent picker; closing
  Desktop preserves relay availability, stopping executor removes it.
- Human remains online while local agent expires offline; human becomes away
  while relay agent stays online. All relevant avatar/header surfaces agree.
- Browser has no scan affordance, gets real Desktop/executor doorways. Model
  empty, loading, incompatible, changed, missing and reauthorization states
  each lead to the documented repair, including keyboard and narrow layout.
- Offline send shows one bounded wait line; cancel/retry works; no cloud
  request is observed. Unchanged inactivity produces no accumulating messages.
- Bell link opens exact repair cold; reload, local Back and browser Back work.
- Private agent and host names never appear for an unauthorised administrator.
- Run the element inventory audit: every screenshot element maps to one row
  and its actual decision; remove unexplained counters/badges/controls.

Mock-model cases prove workflow and policy, not natural-language competence.
Keep a small live-model eval set for greeting, tool selection, a two-step task,
context compression, cancellation, non-English (Czech), slang and misspelling.
Human-score correctness and unwanted replies; use the model for meaning,
never implement regex/keyword intent detection from these fixtures. Record
model digest, tested context, OS/runtime version and outcomes, not private
prompts. Durable fixtures go in the worker harness and the new browser suite;
write `docs/testing/local-ollama-agents.md` with the actual commands and results.

## Concrete Windows machine verification

Initial non-mutating evidence on 2026-09-20:

- `GET http://127.0.0.1:11434/api/version` → `0.34.1`.
- `GET /api/tags` → eleven tags, including `gemma4:12b` with manifest
  `4eb23ef187e2c5462566d6a1d3bbbc2f1346d0b4327cbb66d58fffbcc9b2b05c`.
- `POST /api/show {"model":"gemma4:12b"}` → `completion`, `vision`, `audio`,
  `tools`, `thinking`; these advertisements do not prove quality or memory fit.
- `GET /api/status` → cloud features enabled (`disabled: false`); the observed
  local model's list/show records had empty remote markers. This is evidence for
  testing the structural predicate, not the required cloud rejection fixture.

During implementation, re-read these endpoints because installations change.
Use the existing model selected in the real setup flow; do not download, pull,
delete or overwrite a model for a smoke test. After consent, send a short
synthetic prompt and one harmless tool call through **Nessie**, observing the
stream and local usage row. Then pause only the test host connection to prove
offline/cancel/recovery. Do not stop the user's Ollama service or unrelated
executor, kill another worktree's dev server, or treat direct curl inference
as proof that the Nessie lane works. Actual sleep/crash tests use an isolated
test bridge, with user-device actions only when explicitly in scope.

## Resolved qualifications and later scope

These are binding implementation choices or explicit later scope, not decisions
for implementation to guess.

| Decision | Recommendation / release consequence |
| --- | --- |
| Minimum Ollama chat/tool protocol version | Start from observed 0.34.1; execute compatibility fixtures before setting a lower floor. Keep import-specific minimum separate. |
| Direct Linux secure-store packaging | Use Secret Service and test its missing/locked state. Document the native dependency; fail closed, no silent plaintext keys. |
| Mac App Store entitlement/runtime feasibility | Ship signed direct macOS build first. Investigate separately; do not claim sandboxed store support or smuggle in the executor bundle. |
| Arbitrary model capability reliability | Require a bounded native-tools smoke for tool-bearing agents; retain exact advertised/tested snapshot. Do not claim production reliability from a `tools` flag alone. |
| Prompt/context limits on real hardware | Begin with the bounded defaults in the transport chapter; tune only from measured runs and keep policy limits enforceable. |
| Ollama local/cloud discrimination | Require empty official `remote_host`/`remote_model`, local manifest/metadata evidence at list/show, and empty remote markers on every chat frame. Unknown is ineligible. A real cloud fixture plus outbound observation is a release gate. |
| Host audience | Owner-host-only in V1. Team enablement scopes policy for members' own agents/hosts; there is no team offer or cross-person host. |
| Activation owner | Native confirmation approves an inactive exact binding; Agent Designer Save is the sole transactional activation commit. |
| Context authority | Host-owned fixed effective cap `min(8192, reportedCap, runLimit)`; no V1 screen control. |
| UOA outage | Tri-state decision. Authoritative denial revokes; unavailable refuses dispatch and renders Unknown without fabricating revocation or recovery. |
| Future multi-host failover | Defer. One selected host makes receipt recovery and data recipient consent precise; a pool would need explicit equivalent model/recipient policy. |
| Future cloud fallback | Defer. It would require admin permission **and** agent owner/editor opt-in to an exact cloud route, billing admission, content destination checks and a new run. No current fallback toggle. |

## Acceptance criteria

1. An authorised person attaches an **existing person-owned** agent to their
   own installed local
   model in each transport, on macOS, Windows and Linux, without duplicating
   human/agent identity or requiring a workspace/VM for direct mode.
2. Admin user/team enablement and every lock/precedence rule are server-enforced
   through one resolver and live authority boundary; no durable UOA profile or
   membership copy is introduced.
3. Discovery is automatic after local consent, read-only, fast on the normal
   path and honest on every empty/failure state; no hidden installation,
   download, process start, LAN scan or publish-all-models action occurs.
4. The agent's online/offline status follows real host/model capability within
   the specified TTL, stays distinct from human presence and agent activity,
   and is shown in the existing addressing/conversation surfaces.
5. A local run and every generative utility stay on the exact consented local
   pin, or fail visibly. Offline/overload/revocation never falls back to cloud
   and never strands an unbounded run or repeats completed tool effects.
6. Pairing, per-message proof, tenant/epoch/fence checks, closed prompt
   provenance plus recipient disclosure, owner-host identity, cancellation,
   expiry, encrypted payload/receipt retention and loopback restrictions pass
   adversarial and two-instance tests.
7. Every proposed on-screen **and executor-facing** element maps to the
   experience inventory with a demonstrated decision/action. There are zero
   unjustified controls, data points, badges, duplicate surfaces or hidden doors.
8. Official Ollama remote markers exclude cloud-backed/unknown models at every
   observation and response boundary, demonstrated with a real cloud fixture
   and network observation; a name or loopback address is never the predicate.
9. Durable headless browser flows, native platform checks, actual Windows
   Ollama end-to-end evidence and required CI are recorded. The deployed exact
   SHA and distributed native build ids are verified before calling it live.
