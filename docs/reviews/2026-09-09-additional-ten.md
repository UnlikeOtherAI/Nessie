# Ten additional improvement candidates

Second-pass review against `a3b144e9a`, completed on 9 September 2026. These
are separate from the twelve approved implementation plans in
[`review-followthrough`](../plans/2026-09-09-review-followthrough/overview.md).
This document records proposals; it does not authorize or claim implementation.
Terra inspected the product/recovery paths; the coordinator cross-checked them
and inspected the security, contract and native-verification paths.

## 13. Durable, correctly linked workflow-failure alerts

**Confirmed gap.** `worker/src/control/workflow-failure-dispatch.ts:100` only
delivers push; it returns without a durable UserAlert when push is unavailable.
Its line 94 URL uses `failedRun`, while `WorkflowsPage.tsx:54` consumes `run`.
Create a deduplicated durable alert before optional push, with an authorized
doorway to the exact failed run. Test without devices, duplicate delivery,
revocation and cold-link navigation.

## 14. Trigger-health alerts select the broken trigger

**Confirmed defect.** `admin/src/facades/alerts/hooks.ts:151` emits a bare id
fragment. `useTriggersPageState.ts:206` consumes `trigger-<id>`. Use a shared
trigger URL constructor and prove a bell-alert click opens the affected
trigger's health and recovery controls.

## 15. Automatic-membership health alerts name their remedy

**Confirmed defect.** `worker/src/control/automatic-membership/health-alert.ts:50`
writes `automatic_membership_health`, but `AlertRow.tsx:42` and the alert link
resolver have no matching presentation or doorway. The row falls through to
mention copy and can become read without navigating. Project the rule reference,
describe the authorization failure, and open its reauthorization setting.
Test the whole failed-grant -> unread alert -> rule repair path.

## 16. Reconnect an unhealthy app from its connection row

**Confirmed reachability gap.** `api/src/routes/apps-connect.ts:331` provides
reconnect and line 358 capability refresh. No admin action invokes them, while
`AppConnectionsList.tsx:92` tells the person to reconnect. Reuse these operations
in the app facade and permission-aware row actions. Test expired OAuth recovery
and capability refresh without duplicate connections or broadened grants.

## 17. Permission-aware workflow run controls

**Confirmed defect.** `WorkflowRunDetail.tsx:94` shows Cancel/Retry and step
controls based on run status, without the workflow-admin decision used by its
parent. `api/src/routes/workflows/runs.ts` admits readers but gates mutations
on administration. Pass the effective decision to the shared detail surface;
test reader/admin views and a revocation race that still receives a server 403.

## 18. Task documents retain their project context

**Confirmed navigation gap.** `TaskDocuments.tsx:24-38` only receives `taskId`
and opens `/knowledge-base`. `TaskDialog.tsx:458` already has the task's project
id but does not pass it. Open the existing scoped Project Docs view with its
space/page intent. Test that Back restores task/board context and authorization
is unchanged. A truly non-project document still uses its actual owning surface.

## 19. Prove ownership when reassigning a native push token

**Reverified hardening gap.** `api/src/routes/devices.ts:63` updates an existing
token's user and organization based on token possession and registration
generation. A caller who learns another device's token can rebind it, disrupting
the intended recipient's notifications. Signed generation orders registrations;
it does not prove device ownership. Add an explicit ownership/transfer protocol
while preserving legitimate account switching and stale-request tombstones.
Test cross-user attempts and legitimate device transfers.

## 20. Versioned encryption-key rotation

**Reverified architecture gap.** `packages/runtime/src/secret-crypto.ts:23`
derives the at-rest key directly from the deployment auth secret. Refresh,
connector and push stores use it without a working key-version read path.
Separate signing and encryption roots, introduce a purpose-aware versioned key
ring and re-encryption procedure, and prove old ciphertext remains readable
during rotation before retiring the old key. No compromise was demonstrated.

## 21. One validated client/server record contract

**Architecture follow-up.** `packages/client-core/src/api-types.ts:38` defines
records independently of `@nessie/schemas`; `api-client.ts:134` casts successful
JSON to the expected generic type. Derive the records from authoritative schemas
and parse responses at domain boundaries, starting with channels/projects/agents.
Keep the migration shared by web/mobile/desktop and test malformed envelopes,
missing required fields and allowed additive fields.

**Implemented, 12 September 2026.** `@nessie/client-core` now parses every
successful response envelope and accepts a domain-owned response schema for its
data. The shared web, desktop, and mobile client path supplies the authoritative
channel, project, and agent schemas at those facades; their exported record
types now come from `@nessie/schemas`. Client-core tests cover malformed and
missing-data envelopes, error-only success objects, a missing required channel
field, and an accepted additive field.

## 22. Windows-native PR verification

**Verification follow-up.** All ordinary jobs in `.github/workflows/ci.yml`
run on Linux. Windows Rust tests at `.github/workflows/desktop-windows.yml:213`
and install smoke run through manual/release entry points. Add a scoped Windows
PR job for Windows/native inputs, retaining a stable reported check when it
skips. Keep release signing separate and prove test/installer failures block
the affected PR before a release is attempted.

## Verification limits

These findings were traced through current source and workflow configuration.
The review did not rerun authenticated browser or provider flows, and did not
demonstrate a live exploit. The first implementation batch owns isolated
database and browser verification; none of these ten changes is included in it.
