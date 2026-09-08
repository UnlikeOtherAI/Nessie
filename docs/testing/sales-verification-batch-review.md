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
| Researcher execution after peer delivery | Two observed researcher runs failed immediately; exact cause is being collected in one read-only audit. | Required blocker: diagnose before another live run. |
| Peer failure visibility | The thread showed the coordinator waiting without visible researcher failures. The notification path needs confirmation against records. | Include with execution fix if confirmed; no speculative UI work. |
| Empty successful provider response | Setup completed ten tool calls, then the provider returned no visible answer or tool call. PR 431 adds bounded recovery and passed CI. | Review once, combine any necessary correction with the runtime batch. |
| Custom-app authentication editor | Unfinished changes are preserved in `sales-custom-app-auth`. The current human-initiated peer chain can use its human's personal credential override. | Deferred; not a prerequisite unless the execution evidence proves otherwise. |
| Test-run token ceilings | The original coordinator ceiling interrupted work before delegation. The saved limits were increased without increasing the cost, tool, cycle, or time ceilings. | Preserve current configuration; evaluate actual usage during the single-prospect acceptance test. |

## Next fix and verification batch

1. Finish the read-only audit and replace the unknowns above with exact errors,
   affected paths, and one minimal repair specification.
2. Assign one coherent runtime fix package. Preserve all existing tickets and
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
