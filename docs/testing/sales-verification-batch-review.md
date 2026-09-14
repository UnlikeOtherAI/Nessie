# Sales verification: consolidated batch review

## Working agreement

Collect the current testers' results before assigning fixes. Maintain one
consolidated report, distinguish confirmed failures from hypotheses, and assign
a coherent fix batch rather than a new coding agent for every observation.
Do not repeat passing checks without a relevant change. Use Terra for coding
and Terra or Luna for discovery. Keep Calendar, Meet, and client outreach out
of this verification.

## Confirmed baseline — 8 September 2026

- The production project, sales channel, two agents, dedicated board, planning
  ticket, and three prospect tickets exist and were verified through the UI.
- Both agents have reusable checklists and bounded peer-handoff instructions.
- The project-scoped KiloTalk connection is connected and both agents are
  allowed its ten read-only capabilities. Successful research reads through
  this connection are not yet established.
- Coordinator continuation `f39fb362-532f-4a69-aca8-a1e925593e0d` completed and
  delivered three research handoffs. The researcher runs then failed; no
  completed research, return handoff, or joint decision is established.
- PR 431, head `d70571f31993cc34d8d7a3858279968e202c7ff5`, passed all nine
  checks in CI run `34269070552`. Review of its final recovery/lifecycle
  behavior is part of this batch. It has not been merged at this checkpoint.
- Model-specific output limits and Deep.Agent compaction integration have
  regression coverage. A live sales-run compaction remains unproven.

## Consolidated findings

| Item | Evidence and status | Batch decision |
| --- | --- | --- |
| Researcher execution after peer delivery | Both executed researcher jobs failed with `Ledger-routed requests require non-empty team_id attribution.` Agent and channel had the same non-null team, but the peer job's actor tenant omitted it. No inference or KiloTalk call occurred. | Required: carry the authorized channel's team/project attribution into the peer run; preserve the original human effective user. |
| Peer failure visibility | The coordinator showed only its initial waiting message. Peer jobs are non-interactive, and their failure path did not publish a result or failure to the waiting conversation. | Required: one visible terminal failure per affected delegation, with a useful remedy and no retry loop. |
| Delivery/serialization accounting | Three briefs were marked delivered, while two runs/jobs were recorded. The Nordbeans brief has no independently recorded run. Coalescing versus unprocessed work remains to be verified. | Trace every brief to consumed input or a visible failure; do not assume one brief must equal one run. Test progress after predecessor failure. |
| Empty successful provider response | PR 431 passed CI and review confirmed one no-tools attempt, preserved effects, legacy checkpoints, and failed rather than successful terminalization. Its generic `empty_response` retry arm is currently unreachable from that terminal path. | Keep the working patch. Make the classification explicitly terminal and add a focused regression; no second recovery mechanism. |
| Custom-app authentication editor | Unfinished changes are preserved in `sales-custom-app-auth`. The current human-initiated peer chain can use its human's personal credential override. | Deferred; not a prerequisite unless the execution evidence proves otherwise. |
| Test-run token ceilings | The original coordinator ceiling interrupted work before delegation. The saved limits were increased without increasing the cost, tool, cycle, or time ceilings. | Preserve current configuration; evaluate actual usage during the single-prospect acceptance test. |

## Next fix and verification batch

1. The read-only audit is complete. The combined runtime package is attribution,
   failure visibility, brief accounting, and the small classification correction.
2. Assign that package to one Terra coding agent. Preserve all existing tickets and
   completed tool effects; do not replay setup or start unrelated improvements.
3. Run targeted checks for changed behavior and the required CI gate once.
   Reuse the already-green PR 431 evidence where its code remains unchanged.
4. Verify one prospect end to end through the browser: research reads, saved
   checklist results and citations, explicit return handoff, coordinator
   review, and a persisted contact/defer/reject decision with reasoning,
   contact route, uncertainties, owner, and next action.
5. Only after that passes, repeat for the other two prospects and inspect the
   final board for duplicates, missing evidence, and incomplete steps.

Any new observations during a test pass go into this report. They do not
immediately trigger another coding agent. Conclude the pass first, except
where continuing would cause unsafe or destructive effects.

## Runtime batch specification

- Reuse the already-authorized thread/channel context in
  `worker/src/control/mailbox.ts`; the rejecting Ledger attribution validation
  in `packages/runtime/src/ledger-attribution.ts` is correct and stays strict.
- Verify attribution, original `effectiveUserId`, and personal credential
  selection through a peer-delivered inference fixture. Use test credentials,
  never production secrets.
- Follow all three delivered message IDs through serialization and failure
  cleanup. Repair only a demonstrated loss/stall; legitimate coalescing is
  acceptable if all briefs enter the consumed input.
- Connect terminal peer failure to the waiting coordinator/conversation using
  the existing lifecycle machinery. Preserve disclosure boundaries, prevent
  duplicate notices, and do not add an autonomous retry or acknowledgement loop.
- Keep the empty-response fix on the existing finalization path. Treat its
  exhausted recovery classification as terminal rather than advertising another
  retry in the generic resolver.
- Complete targeted regression checks and one required CI pass before the next
  live browser test. No production setup replay or additional UI work belongs
  in this batch.

## Combined implementation review — PR 431 at `ae07d3c80`

The first implementation batch is pushed. Worker typecheck passed; the author
did not run the added database tests because its isolated fixture was unavailable.
CI run `34271980606` is complete: three checks passed and six failed. Review
found these corrections to resolve together before deployment:

- **Preserve every brief's disclosure and requester.** The new raw
  `promptOverride` concatenates hidden messages, but `run-job.ts` admits only
  the selected trigger message's lineage. Earlier messages' restrictions and
  original authors therefore disappear. Their actor contexts may also differ.
  Keep each consumed brief attached to its durable message and authorized
  requester. Processing peer briefs separately is acceptable and may be simpler
  than introducing a new combined-prompt mechanism.
- **Keep mixed pending work intact.** Concatenation only happens when the latest
  pending message is `system`; a later human turn still drops earlier hidden
  briefs. It also applies to ordinary scheduled kickoffs whose latest-only
  behavior is deliberate. Scope the repair structurally to peer work and retain
  unconsumed pending markers for subsequent drains.
- **Restore format-error recovery.** The switch modification made both `format`
  and `empty_response` terminal. Only exhausted `empty_response` belongs in this
  change; preserve the existing bounded format retry.
- **Use the schema's typed ID parsers.** CI rejected `mailbox.ts:84` with TS2322
  because raw strings were assigned to branded project/team IDs. This one error
  failed Type Check and the four build-dependent jobs. Rebuild dependencies
  through Turbo before trusting local typecheck results.
- **Prove the promised lifecycle.** The new serialization test completes its
  predecessor rather than failing it, and the failure test calls the handler
  once while deleting the unattended-silence regression. Add meaningful checks
  for failed-predecessor progress, mixed/private briefs, terminal redelivery,
  ordinary unattended silence, and original-human credential selection.
- **Finish the delivery evidence.** Update the affected standard and comments,
  build the worker, run changed behavior through the documented Turbo/isolated
  database path, and accurately describe both the original empty-output fix and
  this runtime correction in the final PR body.

The Test job also failed the existing `the retries an execution spends are
carried in its checkpoints` assertion: the format error was no longer retried.
The worker unit failure prevented its database suite from running. These are
the complete current CI findings; return this one correction package to the
existing Terra agent. Do not start live sales runs against this unverified
implementation.

## Final local checkpoint — 8 September 2026

The consolidated runtime repair is ready for PR review. Peer mailbox delivery
uses the authorized channel's typed project/team attribution while retaining the
originating human effective user. Serialized peer briefs drain individually in
FIFO order; ordinary pending work still batches, and a later scheduled marker
cannot replace a selected peer's hidden message or restricted basis. Terminal
peer failures now use the existing lifecycle message path, while unattended
work remains quiet. The empty-output recovery remains bounded and terminal only
after its one no-tools recovery; ordinary format errors retain their existing
bounded retry.

An owned loopback-only Postgres/pgvector fixture on port 55440 was migrated and
used for the retained Turbo worker test run. It completed with 1,090 unit
passes and four expected environment skips, plus 170 database passes with no
failures. The mixed peer/scheduled serialization regression also passed in the
same fixture. This establishes runtime behavior only. A live KiloTalk research
read and live compaction invocation remain pending; no new product work belongs
in this batch.

## Peer-context follow-up — local batch pending review

The Eska pilot exposed a distinct deployed gap: the coordinator's immediately
preceding run could enter its personal Ledger lane, while a peer-delivered
researcher run could not because durable mailbox work retained the original
human id but not the verified UOA tuple required at admission. This batch stores
the tuple on peer mail as immutable run provenance, restores it for direct and
serialized delivery, and leaves Ledger's live link, epoch, subject, and active
team checks unchanged. Missing or malformed tuples remain terminal rather than
falling back to another identity. Direct hidden-mailbox work now uses the same
channel reply placement as serialized work, so the existing lifecycle posts one
useful terminal result for a waiting conversation and a redelivery adds none.

The coordinator configuration was corrected through the Tools UI and persisted
after reload: `ticket_checklist_apply` is disabled, while project read and
step-update remain enabled (Projects & tickets: 9/12). The original Eska pilot
ticket was renamed **Eska — failed pilot record (8 September)**, annotated with
its failure history, and cancelled into Archived; reopening it confirmed the
six-step snapshot and completed **Confirm sales brief** result remain intact.
The board now has three active and one archived ticket. No fresh prospect,
paid research, live KiloTalk read, or compaction run has occurred. The next
pilot remains blocked on review, merge, CI, and deployment of this batch.

Local validation for this follow-up is recorded with the retained Turbo worker
test artifact after the batch checks complete; the earlier 1,090-unit/170-DB
checkpoint above belongs to PR 431's already merged runtime repair.

The board UI regression is covered by the reusable project-usability browser
journey: an existing task can retain its Checklist URL when closed, while the
next New task dialog returns to Details and exposes its title and create action.
Cards prefer an explicit titled task excerpt (`purpose`) over implementation
detail, with detail retained as the fallback when no excerpt exists.

## Final local validation — ready for CI

The completed peer-context batch passed Turbo worker validation (29/29 tasks):
1,090 unit passes with four expected skips and 171 database passes. The nine
focused mailbox admission, serialization, and terminal-failure regressions also
passed. Combined API, worker, and shared typechecks passed 33/33 tasks; the
admin/worker final typecheck also passed 33/33, and the final admin typecheck
passed 9/9. The full headless project-usability journey passed against its own
isolated database with the owned API on 5454 and Vite on 5455, including the
retained-checklist New task dialog and explicit-excerpt card screenshots.

The coordinator remains configured without `ticket_checklist_apply`; project
read and checklist step-update remain enabled. The archived failed-pilot record
is preserved, and the fresh active ticket is **Eska — research and contact
decision**. No paid research kickoff, live KiloTalk read, or compaction run was
performed during validation. Production remains pending CI, merge, and deploy.

## Eska research-progress follow-up — local batch in review

The deployed Eska peer run stopped at its token ceiling across three bounded
parts. The first part had channel reply placement and a null checkpoint root;
automatic continuations failed to copy that placement, so their replies were
threaded under the hidden peer brief. The continuation checkpoint was already
claimed by its new run id, so the load query remains eligible regardless of the
reply root; the repeated discovery needs transcript-level diagnosis rather than
a false checkpoint-root explanation. The repair preserves the original
placement for every automatic part. It keeps the existing checkpoint note,
source basis, peer payload, captured UOA provenance, and final lifecycle
outcome; it does not invent a completion or an automatic peer return.

The project-scoped KiloTalk connection was active but its ten shared-scope
capabilities were correctly awaiting explicit owner review, so the worker
offered no KiloTalk tools during the pilot. A separate channel-scoped instance
had active rows and made the App detail's app-wide access summary misleading.
The owner reviewed exactly the ten project rows through the existing Tools
surface; no credential, grant, or other instance changed. The App access view
now retains the existing filtered Tools doorway whenever a mixed set of
connections includes pending-review capabilities, without weakening the review
gate. The pilot had no observable compaction invocation: its one extra model
call per part was the checkpoint note, and Nessie continues to use only the
existing `@deep/agent` compaction helper. Astro markup in a `web_fetch` result
was not the demonstrated cause and is outside this repair.

Local validation for this follow-up passed: the full worker Turbo run recorded
1,090 unit passes and four expected skips, followed by 171 database passes.
Admin unit tests passed 1,459/1,459. The reusable headless App fixture verifies
the mixed-review doorway and a real access toggle: three serialized policy
PATCHes are followed by one final policy-target refresh, avoiding the former
per-capability PATCH/GET burst.

After review, the exact ten project KiloTalk capabilities were active, but the
two sales agents initially showed partial access because the App toggle sent
one policy PATCH per capability and invalidated the active policy-target query
after every success. Production logs showed the resulting PATCH/GET burst,
followed by rate limiting and a partial prefix. The fan-out remains serialized
through the same single-entry route and now defers all invalidation until its
one settled outcome, including a partial failure. A bounded UI retry confirmed
both coordinator and researcher at 20 of 20 capabilities. No authentication,
credential, grant scope, or live run changed.

## Fixture references

- Project: `8c03c93d-0175-4b74-ba79-391da2e938be`
- Channel: `29d5a59f-01a4-46db-bb28-93dd18d8b8dd`
- Board: `63760773-95e2-4127-bb88-1d10d71d8bb2`
- Planning ticket: `275cdbf6-c84c-4305-8c12-2aeb3ccb1358`
- Eska: `ec7c28aa-d2cd-4665-9d14-ea0b3add7cbf` (KiloTalk customer 28)
- Nordbeans: `1815d0d8-220e-4687-9291-ad2be1bd0c9c` (customer 25)
- Můj šálek kávy: `a15e385e-d9a9-443d-951a-fbc89dbb2f5e` (customer 40)

The commercial brief concerns KiloMayo's hospitality platform. KiloTalk is
the research portal; its Respond.io integration is not a prospect
qualification requirement. See the existing
[verification evidence](sales-agent-collaboration.md) for prior results.
