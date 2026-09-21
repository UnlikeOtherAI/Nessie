# Kimix review: sequential task sets

Reviewer: kimix, using `k3-256k` through the Kimi provider, on 2026-09-21.
The findings below are the reviewer's report; the maintainer's assessment is
separate at the end. This records a review, not resolution of its findings.

**Revision:** document as of baseline commit `0f31c4383` (worktree `task-set-kimix-review`); the document's internal audit was against `57a2642d2`.
**Scope:** static design review of `docs/plans/2026-09-21-sequential-task-sets-gap-map.md` only, plus two substantiating reads: `docs/standards/capability-health-alerts.md` and `api/src/routes/local-inference-attempt-routes.ts` (lines 30–70). The audited inventory was not redone. "Verified" below means confirmed in source this turn; otherwise the claim is a design assumption taken from the document.

## Findings

**P1 — No health alerting for a job whose failure mode is silent waiting.** Lines 40–42, 155–158, 309–336, 416–423, 464–468.
Verified: the standing standard (`docs/standards/capability-health-alerts.md`) requires that any capability which can stop working classify the failure into a remedy-naming state, persist the reason, and emit exactly one durable `UserAlert` per transition (`health_revision` + `(user_id, event_key)` uniqueness) with a deep-link doorway — written after a trigger sat dead and silent for nineteen days. The design defines exactly the states that standard exists for — paused-after-retry-exhaustion (157), revoked authority/removed source (225–226, 311), host offline for days (326) — but its only communication surface is the detail view a person must happen to open, plus "conversation progress" (434). Failure scenario: on day 12 of a 55-day job the Ollama search credential expires; the set enters waiting with a reason rendered on a page nobody has open, and the person discovers a dead job weeks later. Minimal recommendation: add a requirement that every set/host transition into waiting, paused-for-intervention, blocked-authority and retry-exhaustion writes one deduplicated `UserAlert` per transition keyed to the set, deep-linking to the detail view, reusing the trigger/workflow alert pattern rather than inventing a new marker.

**P1 — Disclosure-basis obligation for processor runs is stated as "retain," not as per-dispatch registration.** Lines 141–145, 388–393, 477–478.
Verified (standing rule, routed in AGENTS.md): every read entering a run's context must feed the run's disclosure basis in the same change; an empty basis is unrestricted, so a forgotten read fails open. The design requires retaining the source's basis "through item results, saved files, progress metadata, dependency reads and the receiver's context," but never states the load-bearing invariant: each per-item processor invocation is a *new run* performing new reads (frozen inputs, earlier committed results, source rows), and each such read must register into that run's basis at dispatch, with a dependency read carrying the producing item's basis. "Retain" reads as a provenance-metadata obligation, which an implementer can satisfy with a lineage column while the actual run basis stays empty — and empty fails open, so 80,000 items of a restricted workbook become answerable to anyone the receiver talks to. Failure scenario: item results from a HR spreadsheet are saved correctly, but the receiver's synthesis run has an unrestricted basis and quotes them in an unrelated conversation. Minimal recommendation: name the sink explicitly — "every item input, dependency result and source-row read entering a processor or receiver run registers in that run's disclosure basis before the model sees it; an unregistered read is a dispatch-blocking defect" — and add it to the verification list (477) as a fail-open test, not just a leak test.

**P2 — The 8,192-token local context cap has no overflow contract, inviting silent truncation.** Lines 16–17, 70, 141–145, 297–299.
Design assumption (document-cited, not re-verified): local input context is capped at 8,192 tokens. A set carries shared instructions plus an objective (16–17), each item carries its own prompt and bounded input (70, 87–89), and dependencies pull committed earlier results (141–142) — three additive contributors against one small fixed cap. The document says inputs "must be bounded" but never says who enforces the bound, when, or what the person sees. Failure scenario: a set with a 600-token shared objective and items depending on two verbose earlier results passes authoring, then either fails at dispatch 40,000 items in, or — worse — an implementer truncates a dependency result to fit, and the model answers from a silently amputated input while the row is marked complete. Minimal recommendation: define a deterministic pre-dispatch (ideally pre-start, at authoring/preview) context-budget validation that fails the item or the set configuration with a named reason and remedy; state explicitly that truncation to fit is never permitted.

**P2 — "Physical inference resource" admission has no defined resource key; the obvious key double-books one Mac.** Lines 138–140, 163–167, 301–307.
Verified: attempt leasing is scoped by `hostId` (`local-inference-attempt-routes.ts`, the lease transaction selects and updates `where: { hostId: daemon.hostId }`), and nothing counts machine-wide slots. Verified per the document (304–305): Executor and Desktop enroll separate host identities. The design correctly demands admission account for the physical machine, but never defines the identifier that makes two enrolled host identities resolve to one machine. Failure scenario: an implementer adds a per-host-identity slot counter in the API; the user's M4 Mac Mini holds one executor identity and one Desktop identity, gets two slots, and two sets run concurrent 70B-model requests on hardware that tolerates one — the exact requirement (140) is violated by a conforming implementation. Minimal recommendation: before dispatch design, specify the machine-level resource identity (shared by both enrollment paths), leased server-side transactionally with the item claim, and add "two host identities on one machine, two sets, one physical slot" to the multi-worker verification case at 457–459.

**P3 — Dependent behavior on a skipped or permanently failed item is undefined.** Lines 114–115, 154, 157–158, 331.
The document forbids fabricating a result for dependents after an explicit skip (157–158) but never says what dependents then do: block with a named reason, run with the dependency absent, or pause the set. Three implementations, all "conforming," produce three different jobs. Failure scenario: item 4,100 exhausts retries and is skipped; item 4,500 declared a dependency on it and now runs against a missing result — the model either hallucinates the absent input or the run errors with a misleading message, and the person cannot tell which rows downstream are trustworthy. Minimal recommendation: one sentence of invariant — an item whose declared dependency has no committed result is ineligible with a named blocked reason; skipping an item requires an explicit per-dependent choice (block or drop the dependency), recorded on the item.

**P3 — The verification section omits the controls it mandates and names no harness for the recovery matrix.** Lines 328–331, 416–423, 457–468, 479–480.
The surface must show Pause/Resume/Cancel/Retry and waiting/failure reasons (419–421), and the recovery table (324–331) defines six pause/restart interactions — but the browser flows (479–480) cover only navigation, waiting-state visibility and saved results, and the durable-recovery evals (457–468) specify crash/pause/revocation matrices with no stated injection mechanism. Given that browser suites are opt-in and nothing catches a regression unless requested, an unspecified harness means these flows simply never run. Failure scenario: the paused-host banner and Resume revalidation (330) ship unverified; a heartbeat clears a persisted pause in the UI while the server correctly stays paused, and the person resumes a job they believe is stopped. Minimal recommendation: extend 479–480 to exercise host-pause-from-executor, independent set pause, retry-exhaustion and resume-revalidation rendering in the detail view, and name the fault-injection harness (mock provider + restartable worker) that 457–468 will run under.

## Key implementation gates

1. Set/host transition alerting (exactly-once `UserAlert` per transition) specified before the waiting/pause states are built — it is a first-release requirement for a multi-week job, not a follow-up.
2. Per-dispatch disclosure-basis registration named as a blocking invariant, with a fail-open test, before any processor run reads item or dependency data.
3. Context-budget overflow contract (validate early, fail named, never truncate) fixed before the processor invocation shape is built.
4. Machine-level slot identity defined and leased transactionally before cross-set admission is implemented; verified with two host identities on one machine.
5. Dependent-on-skip semantics fixed in the document before the dependency validator is written.

This was a static design review of the document against two source/standard files. No runtime, browser, or 80,000-item validation was performed or claimed; the document's own arithmetic (9.3–55.6 days) and capacity figures remain unverified design assumptions.

## Maintainer assessment

The six findings identify requirements that should be made explicit before
implementation. The referenced disclosure rule, health-alert rule and
per-host lease predicate were checked again after the review. These are
design risks, not evidence that the unimplemented task-set feature has leaked
data or lost work. The proposal remains unchanged apart from a link to this
review; the findings remain open.

The recommendations need these qualifications when resolved:

- Alert on actionable or meaningfully prolonged stalls with a defined
  transition policy; do not turn every routine capacity wait, brief offline
  interval or intentional pause into another notification. Use the existing
  deduplication and entitlement-aware alert paths.
- Context admission must reject silent loss of requested inputs. Explicit
  source-column selection, configured bounded projections and artifact
  references remain valid ways to fit an item. Input, tool/schema and output
  allowance need to be accounted for together.
- A physical-resource identity must be backed by the authorized enrollment
  and host enforcement, not guessed from a machine label. No lease timeout
  alone proves a previous local inference has stopped.
- A dependent without a committed required result must stay blocked. Dropping
  a dependency is an explicit authored change, never an automatic retry or
  skip behavior; the review does not require a new per-dependent dialog.
- The elapsed-time examples are correct arithmetic scenarios. Their inputs
  are not measured Ollama throughput, and neither the examples nor this
  review establish performance on the user's Mac.

The review is scoped to the proposal and two targeted source/standard reads;
it is not an exhaustive implementation audit. No product, API, worker,
executor, model-selection, permission or browser behavior changed here.
