# Sales-agent collaboration verification

This workflow checks that a person can configure a researcher and coordinator,
have them review a small prospect set together, and retain the work in a project.
The default test brief is three Czech hospitality prospects for KiloMayo.

## Evidence and connections

KiloTalk is the primary research source. Its admin is
<https://kilosupport.kilomayo.dev/admin>; its Streamable HTTP MCP endpoint is
<https://kilosupport.kilomayo.dev/mcp>. Settings → API keys issues a revocable,
read-only research key; the legacy `KILOTALK_MCP_BEARER_TOKEN` has broader access.
Both are separate from the portal password. Keep credentials in the configured
secret store, never in agent instructions, task details, or this document.

For an unknown prospect set, start with `sharpgrid.facets` and one bounded
`sharpgrid.outlets.browse` page. When record IDs are already known, read those
records directly instead of repeating broad catalogue or customer-list calls.
Use existing source payloads or scan history before requesting a new scan.
Grant only the research tools needed by the test;
KiloTalk's full MCP also contains unrelated write operations. A paid discovery
job, customer message, or client invitation is outside this initial test.

Keep observed facts, source dates, confidence, identity uncertainty, and the
agent's proposed approach distinct. A source score or an estimated revenue
figure is not independent evidence that a prospect should be contacted.

The bounded live test uses Eska (KiloTalk record 28), Nordbeans (25), and
Můj šálek kávy (40). Manual portal inspection found uncertain entity/location
links for Eska, limited cached register data for Nordbeans, and no intelligence
for Můj šálek kávy. These are test inputs, not qualified leads. Agents must
resolve material gaps with current primary sources or explicitly defer the
prospect. A successful run records a contact, defer, or reject decision for
each record; it does not have to recommend contacting all three.

## User walkthrough

Perform setup through the UI at `http://localhost:5455`. The local API remains on
5454. An empty local installation may be initialized through its bootstrap UI;
do not seed the agents, project, board, or prospect tasks through SQL or HTTP.

1. Create a test project and a shared planning channel.
2. Create a researcher and coordinator in Agent Designer. Verify that changing
   configuration sections preserves the draft. Set small run budgets and grant
   the required tools explicitly. Bind both agents to the planning channel.
3. Enable reusable to-dos and author a prospect-research template. Its steps
   cover venue/legal-entity resolution, existing relationships or hold-offs,
   cited business evidence, buyer-role hypothesis, gaps, proposed approach,
   and the coordinator's decision with a next action.
4. Initiate the bounded research brief in the channel. Verify an actual peer
   request and response, including a requested correction or disagreement.
   Reading research must retain its disclosure restrictions through delegation.
5. Have the coordinator create the sales board and one task per agreed prospect.
   Each task contains source links, the reason to approach it, the proposed
   approach, an assignee, and the next action. Verify board isolation.
6. Apply the reusable checklist to a new prospect task and an existing task.
   Record and clear a result independently of its checkbox. Reopen or reload;
   results and completion must persist. Reapplying must preserve progress.
7. Inspect the same task in a second session. A saved checklist change should
   refresh there while preserving an unfinished local edit.
8. Check the existing Google `calendar_event_create` flow, including the
   calendar-write grant, approval, time zone, and optional Google Meet link.
   Use a disposable event with no client attendees for an authorized live test.

## Regression evidence and completion

Run package tests through Turbo with `DATABASE_URL` exported against a dedicated
database. Cover denied source/target access, revoked project administration,
delegation depth, retries without duplicate work, disclosure preservation,
checklist races, transaction rollback, and UI persistence and error handling.

Provider mocks verify wire contracts and deterministic lifecycle behavior.
They do not establish real research quality, agent consensus, a working MCP
credential, or a real Google Meet invitation. Record these outcomes separately.
Completion requires browser evidence for the configured agents and project,
passing required CI, a merged PR, and removal of the merged task branches.

## Observed results, 7 September 2026

The live browser walkthrough created **Sales Researcher — Test** and
**Sales Coordinator — Test**, with bounded runs, an eight-step research template
and a six-step planning template. Both were bound to `sales-planning-test`.
Their current saved test ceilings are 40,000 tokens, 50 tool calls, 20 cycles,
and ten minutes, with Low effort. The researcher keeps a 25-cent ceiling and
the coordinator a 30-cent ceiling. These values and their handoff instructions
were verified after reload. The coordinator creates one planning ticket and
supplies prospect ticket IDs; the researcher applies its own research template
to those tickets. This configuration has not yet completed a live backlog run.
KiloTalk's Settings API-key page was deployed through
[KiloTalk PR 20](https://github.com/UnlikeOtherAI/KiloTalk/pull/20). A new research
key was generated in that UI and entered into Nessie's encrypted credential
dialog. The channel-scoped **KiloTalk Sales Research** app connected, discovered
exactly ten read-only tools, and was approved and granted to both agents.

The production API-key lifecycle was also exercised with a disposable key:
create, reopen settings with the secret hidden, and revoke. The research key
remains active in Nessie's encrypted connection. Browserbase's personal
connection check successfully opened and closed a browser session; an agent's
actual browser research has not yet been verified. The researcher has explicit
open, observe, act, and close grants, verified through the tool-access UI.

The local Agent Tools screen now exposes eligible project tools and lets
organization owners grant protected browser and peer tools through the existing
registry policy route. Generic create/update requests still cannot grant these
protected tools. Nonowners do not query the owner-only registry, and executor
tools remain managed from Executors. A real local UI walkthrough verified
`browser_open` enabling and revocation after Save and reload. Peer and project
ticket controls still need their final browser walkthrough; no live deployment
of this correction is claimed here. The reusable driver is documented in
[`admin/e2e/tool-access-ui-proof`](../../admin/e2e/tool-access-ui-proof/README.md).

The researcher called KiloTalk's catalogue and customer-list tools, then stopped
at a run token limit before returning research. A checkpoint continuation also
stopped without a useful answer. Code inspection shows continuation reloads
the current agent run limits, but the UI evidence does not establish the
provider finish reason or the precise cause of either stop. These are
failed research attempts, not evidence of consensus. Further live retries wait
for the separate output-admission and recovery work.

The walkthrough also reproduced an existing project-creation defect:
**Sales Agent Verification — KiloMayo** was created, but the form's subsequent
attempt to create a local team failed. Adding a channel from that project's
menu then placed it in **General**. The test project therefore has no usable
project-channel relationship. Do not treat this as a successful new-project
walkthrough or fabricate a local UOA team to make it pass. The authoritative
remedy is the project/team API and data migration described in
[the team-model standard](../standards/team-model.md).

Local combined API/worker builds passed. The full admin Turbo suite passed
1,451 tests including the tool-catalog regressions. Postgres checks verified concurrent checklist application and
restricted-source propagation through peer mailbox delivery. Google Calendar
tests verified the Meet request contract with a provider mock. Earlier broader
Windows runs failed because their Docker executable and `chmod` fixtures
assumed POSIX. Those Docker fixtures now inject a command runner per invocation,
including cleanup, so they cannot resolve an installed Docker executable.
Linux CI remains the merge gate. These checks do not yet prove
live agent consensus, generated prospect tasks, or an actual Meet link.

The live Google connection is disabled with **Not set up on this server**.
The required server OAuth client configuration is absent; connecting a user's
account cannot complete until that configuration is supplied. No real calendar
event, client invitation, or Meet link was created during this verification.

Headless component fixtures at `localhost:5455` exercised designer draft
preservation across tabs, checklist application and result saving, local-draft
clearing, and the task Details surface. The final fixture also verified the
Calendar/Meet capability picker and the actual Details-to-Checklist switch,
including retaining Checklist after reload. The checklist checkbox sizing and
an effect that reset the selected tab were corrected after browser review.
These fixtures use mocked API responses;
they supplement the production walkthrough rather than replace it.

A later headless walkthrough used the real local UI, API, and isolated database,
with only the upstream Ledger model catalog replaced by a local fixture. It
created an agent, enabled to-dos, authored a reusable template, and created a
board and task under the setup-provided default project. Applying the template,
toggling completion, saving a result, reloading, clearing only the result, and
reloading again all passed. Completion remained set after the result was cleared.
The walkthrough exposed stale checklist state after a successful mutation;
the client now installs the returned checklist in its cache before invalidation.
The reusable driver and PowerShell instructions are in
[`admin/e2e/sales-real-ui-catalog`](../../admin/e2e/sales-real-ui-catalog/README.md).
This establishes checklist persistence, not live model research or consensus.

## Resumed live verification, 8 September 2026

Calendar and Google Meet are explicitly deferred by the user for this test.
No client outreach, invitations, or paid rescans are part of this walkthrough.

Nessie PRs 401, 403, 404, 405, and 406 are merged. Successful
[Deploy run 34242931714](https://github.com/UnlikeOtherAI/Nessie/actions/runs/34242931714)
deployed commit `574a67afc0884aacefc30feb18c7704eae25fecd`, which contains those
changes. The private Deep.Agent dependency therefore no longer blocks that
deployment. This does not establish that a live run invoked compaction.

The production Agent Tools UI now passed Save/reload checks for the researcher
and coordinator's peer and project-ticket grants. The researcher's **Ask Bound
Peer** grant additionally passed enable, revoke, and restore checks after reload.
The researcher's four browser grants remain enabled. The coordinator has no
browser grants; its browser panel incorrectly displays a load failure instead
of explaining that access is disabled. That usability defect remains under repair.

The coordinator's six-step template was corrected through the UI: apply it only
to the planning ticket, and have the researcher apply its eight-step template
to prospect tickets. Its meeting step now records the Calendar/Meet deferral.
Both changes persisted after reload. After the failed run below, the Behavior
tab still showed 40,000 tokens, 50 tool calls, 20 cycles, ten minutes, and 30 cents.

A fresh, structured-mention coordinator request at 17:09 used the three cached
customer IDs directly: Eska 28, Nordbeans 25, and Můj šálek kávy 40. The tool log
showed successful reads of all three records and the default General board.
`ticket_board_create` then failed with **I cannot copy restricted research into
this shared project**. The channel-scoped MCP source does not authorize copying
its results into the wider project audience; this denial must remain enforced.
The intended sales project still needs its proper team/channel relationship and
a connector audience consistent with the board destination.

The run stopped at 14,483 tokens without an answer. Source inspection identified
a recovery defect: run-budget clamping can reduce requested output to zero before
the compaction predicate is evaluated, preventing a potentially useful forced
compaction. The deferred-tool wrapper also appends the full argument schema to
policy failures. These are confirmed code defects, but the exact projected input
size for this live stop was not available; do not present it as measured evidence.
No new board, prospect tickets, peer handoff, or consensus was confirmed.

KiloTalk PR 21 was also verified in the deployed browser: Eska's Intelligence tab
starts with **20 complete · 1 needs attention**, and **View all 21 source checks**
expands readable source names and statuses. Collapsing the operational detail
keeps the research summary visible without removing access to evidence. This
verification read the cached record and did not start another scan.

### Follow-up repairs and bounded research setup

PR 419 removes the false browser-load error when an agent has no browser grant.
Its final CI browser screenshot showed the settled Tools surface, and successful
[Deploy run 34254211932](https://github.com/UnlikeOtherAI/Nessie/actions/runs/34254211932)
landed the change. A production walkthrough then expanded the coordinator's
Browser category and confirmed its six disabled tools without the false error.

PR 421 adds the missing **A project** choice to app connection setup. All nine
CI checks passed before merge. A real local API and Vite walkthrough verified
that Connect stays disabled without a project, becomes available after choosing
one, and shows the correct audience after switching Project → Channel → Project.
That local walkthrough did not connect an external account.

PR 422 repairs zero-output admission recovery and passed all nine CI checks
before merge. Successful
[Deploy run 34255063666](https://github.com/UnlikeOtherAI/Nessie/actions/runs/34255063666)
landed that repair. Recovery has its own durable attempt marker, so earlier ordinary
compaction does not disable it. Checkpoints preserve the recovery result and
utility spend even when the utility call exhausts the run budget. Full argument
schemas are now attached only to structural argument failures. These regression
tests establish recovery behavior; a new production run is still required to
prove the sales workflow and any live compaction invocation.

Both agents' prompts were updated through the production editor and verified
after reload. The coordinator now creates the board and tickets before loading
large research records and delegates one prospect per bounded peer request.
The researcher saves findings and source URLs throughout the run, keeps missing
evidence explicit, and returns a short recommendation referencing its ticket.
The prompts identify the peer agents directly, preserve the reusable templates,
and explicitly defer Calendar/Meet and client outreach. A separate read-only
KiloTalk research credential was created through Settings → API keys for the
project-scoped connection; its value is not recorded in this document.

Peer delegation is asynchronous mail, not a result RPC. A normal researcher
reply does not wake the coordinator. The saved prompts therefore require one
explicit `agent_peer_delegate` return handoff after research, carrying the
ticket reference and a concise recommendation. The coordinator reviews and
records the decision directly. At most one focused clarification round is
allowed; a final result or acknowledgement must not start another assignment.
The runtime preserves the original human's authority, serializes each
agent/thread, and caps delegation depth at four. The earlier stopping rule is
a prompt protocol, not a separate structural depth-three guard.

After successful
[Deploy run 34256544180](https://github.com/UnlikeOtherAI/Nessie/actions/runs/34256544180),
the production connection review offered the project audience. Its compact
TabBar menu exposed a separate layering defect: options existed in the DOM but
rendered behind the dialog. At the center of **A project**, browser hit-testing
returned the underlying **Connect KiloTalk Sales Research** button. Clicking
that position started an unintended personal connection. That new, unconfigured
connection was disconnected through the UI; no credential was added and the
original channel connection remained connected. The compact menu requires a
layering repair before the project connection can be accepted.

PR 423 is merged at `45b58d9e3` after all nine checks passed in
[CI run 34260161435](https://github.com/UnlikeOtherAI/Nessie/actions/runs/34260161435).
It adds explicit, non-unique project ownership by an existing team and carries
the selected project/team pair into channel creation. A real local API/Vite
walkthrough created two projects in one existing fixture team, created a
channel through the second project's sidebar menu, and verified the live
records, destination URL and sidebar placement after reload. That journey now
runs in the Navigation Transitions gate. It exposed and helped repair stale
team-directory cache state after project creation; incomplete team context now
blocks submission with an explicit explanation.

The migration deliberately does not infer ownership for ambiguous historical
projects. Local team-admin tests passed 336/336 and a full worker run passed
1,077 unit tests (four environment skips) plus 169 database tests. No full local
API pass is claimed: local reruns encountered Windows tooling and a transient
worker prerequisite failure. The final Linux Test and Navigation Transitions
jobs both passed. A new production sales run remains necessary.

## Compaction verification

The sibling `UnlikeOtherAI/deep.agent` repository already exports model-authored
compaction. Its loop invokes it when the host supplies `generateNote`, falling
back to trimming when no compaction hook is supplied. Its private packages
support commit-pinned Git installation with prepare/prepack hooks.

Nessie's worker consumes the pinned `@deep/agent` compaction helper only. Its
caller still owns the utility model call and invocation sink, tool-call/result
grouping, durable checkpoints, and the source and author basis attached to the
run. The shared helper receives no Nessie identity or persistence state. Its
preservation test keeps checkpoint input unchanged and retains an image-bearing
recent turn; run-level tests continue to cover checkpoint recovery and tool
pair integrity.

PR 423 deployment succeeded in run 34261949124. Through the production UI,
the verification created **Sales Verification — KiloMayo**
(`8c03c93d-0175-4b74-ba79-391da2e938be`) in the existing General team and then
created **sales-planning-verification**
(`29d5a59f-01a4-46db-bb28-93dd18d8b8dd`) from that project's sidebar menu.
Both saved sales agents were added through the channel's Members dialog.
After reload the channel remained under the correct project and its Agents
tab showed both agents; membership contained the owner and those two agents.

PR 428's final browser evaluation passed against its conditional preview
fixture in CI run 34263668156. The downloaded screenshots visibly show the
compact audience menu above the connection dialog and the project picker
with Connect disabled until a project is selected. The browser evaluation
also checks hit-testing and Escape behavior. This removes the earlier
unstyled/mid-animation proof ambiguity. Production acceptance and the full
CI gate remain pending at this checkpoint.
