# Architecture and release plans

## 10. Model-judged memory extraction

**Owner:** Sol, because the implementation spans inference, billing and
disclosure boundaries. This is
post-run consolidation; it is separate from conversation-history PR 434.

1. Replace English sentence classification with bounded structured extraction
   through the existing utility-inference path. Inventory its Ledger/personal
   subscription attribution and accounting before adding a model call. Memory
   remains deployment-billed even when the source run uses a personal plan,
   as required by the personal-model-subscriptions standard.
2. Validate a closed candidate schema with source-message ids, category and
   importance. The model judges meaning; deterministic code enforces budgets,
   schema, source membership, size and disclosure lineage. Every semantic
   output inherits all private sources supplied to its inference; model-cited
   ids are trace metadata and cannot narrow that authorization lineage.
3. Preserve Unicode for candidate identity. Do not introduce language detection
   or a regex fallback. Empty/malformed/provider-error outcomes are explicit
   and cannot turn a completed user run into failure.
4. Reuse existing capture, duplicate and source-attachment owners; add no new
   durable memory store. Expose failures through the existing operational path.

**Acceptance:** English, Czech, CJK, slang and misspelled fixtures retain
equivalent facts/preferences/constraints; unsupported source ids are refused;
restricted evidence remains restricted. Test metering, bounded outputs and
failure recovery. Scripted evaluations prove orchestration, while any live
semantic evaluation is reported separately. Update memory/consolidation docs.

**Implemented, 10 September 2026:** consolidation now uses one bounded,
deployment-billed utility inference with strict candidate validation, Unicode
identity and inference-wide disclosure lineage. Scripted multilingual,
malformed/provider-failure, source-membership, metering, bounds and personal-pin
isolation tests cover the contract. No live provider evaluation was run.

## 11. Complete UOA authority and hierarchy

**Owner:** Sol. This is a dedicated migration track, not a quick mirror patch.
Existing durable profile writes violate the current UOA authority invariant.

1. Reconcile the existing UOA unification/SSO plans with current code. Inventory
   available UOA profile, membership, invitation and hierarchy API operations,
   all local writers/readers, system containers and no-IdP behavior. Verify the
   API contract before deleting a required capability; record upstream work.
2. Establish one API-backed identity/hierarchy read boundary with a bounded,
   revocation-aware in-memory cache. Use stable UOA subject/org/team references
   and product-owned extension data only. Do not add durable compatibility
   copies, copied grants, local-password SSO accounts or fallback authorities.
3. Move profile/member/name render projections and mutations onto that owner.
   Tests use a UOA API fixture, including revocation, outages and cache expiry.
4. Audit and backfill the intended organization -> team -> project hierarchy.
   Detect orphaned, ambiguous and cross-tenant legacy records before mutation;
   never guess ownership. Handle system/standalone containers deliberately.
5. Complete the existing expand/backfill/contract sequence: give teams a direct
   tenant binding, migrate references and enforce coherent constraints, remove
   the inverted `Team.projectId` anchor dependency and fabricated projects.
6. Remove durable UOA-owned profile/hierarchy fields and their active writers
   once callers and data have moved. Preserve only a deliberate no-IdP local
   mode; it cannot become an SSO fallback. Each slice must be deployable and
   truthful about what remains, with no falsely completed migration milestone.

**Acceptance:** UOA profile/membership/hierarchy changes propagate through the
API/cache contract without local copies; revocation fails closed; teams do not
fabricate projects; a project has one team; cross-tenant reference combinations
are rejected; upgrade fixtures cover real legacy shapes and preserve all
product-owned documents, tasks and grants. Verify login/switching, member
management and project navigation in headless browser flows. Update the UOA
plans, team standard, affected contracts and the stated identity invariant.

**Staged handoff, 10 September 2026:** the active directory landed in PR 444.
The [remaining implementation plan](../2026-09-10-uoa-authority-next-slices.md)
assigns Sol the purpose-bound UOA grants, commit-ordered outbox, profile and
revocation APIs, followed by Nessie's reader/FK migration and hierarchy contract.
These are implementable cross-repository dependencies, not an external blocker.
Existing bound profile and membership copies remain explicit unfinished work.

## 12. Deploy only the verified commit

**Owner:** Terra; coordinator applies the final repository-setting update.

1. Preserve branch CI and serialized deployment, but bind production checkout,
   image tags and promotion to the SHA whose full main CI passed. A failed or
   cancelled CI run must not deploy; a manual dispatch obeys the same gate.
2. Prefer a completed-CI trigger or an explicit exact-SHA gate. Validate event
   origin, repository, branch and conclusion before running privileged steps.
3. Prevent an older delayed successful run from replacing a newer deployment.
   Define which verified SHA is eligible when multiple merges complete out of
   order; maintain monotonic promotion and existing deploy locking.
4. Add ordinary `Multi-Instance Smoke` to required checks after it has a known
   successful status. Preserve all existing protections, required contexts and
   their integration ids; chaos remains advisory.

**Acceptance:** exercise success, failure, cancellation, manual invocation,
wrong branch/repository and out-of-order completion through workflow validation
and deterministic gate tests. Verify all images and checkout use the gated SHA;
read back branch protection after updating it. Update deployment docs and
`AGENTS.md`/`CLAUDE.md` because this changes the release workflow.

**Repository gate completed, 10 September 2026:** Multi-Instance Smoke passed
on `d07254158` in [PR 442](https://github.com/UnlikeOtherAI/Nessie/pull/442).
It was then appended to `main`'s required checks with the existing GitHub
Actions integration id `15368`. Readback verified all nine contexts and
preserved every other protection field, including `strict: false`, admin
enforcement and the prohibition on force pushes.

**Workflow delivered:** [PR 449](https://github.com/UnlikeOtherAI/Nessie/pull/449)
landed as `51b48c18c` after all nine checks passed. The gate resolves the current
main SHA only after acquiring the shared production concurrency slot and
requires successful CI for that exact SHA. Failed or untrusted events use
separate ignored groups. Deterministic tests cover the actual workflow's
concurrency expression, manual dispatch and delayed CI completion; image tags
and every production checkout use the gate's output.
