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
