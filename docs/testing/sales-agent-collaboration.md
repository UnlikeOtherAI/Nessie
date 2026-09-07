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

Start with `sharpgrid.facets` and one bounded `sharpgrid.outlets.browse` page.
Use existing prospect records and their source payloads or scan history before
requesting a new scan. Grant only the research tools needed by the test;
KiloTalk's full MCP also contains unrelated write operations. A paid discovery
job, customer message, or client invitation is outside this initial test.

Keep observed facts, source dates, confidence, identity uncertainty, and the
agent's proposed approach distinct. A source score or an estimated revenue
figure is not independent evidence that a prospect should be contacted.

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

The researcher called KiloTalk's catalogue and customer-list tools, then stopped
at a run token limit before returning research. A checkpoint continuation also
stopped without a useful answer. Increasing the agent's saved run budget did
not establish that an existing checkpoint uses the new allowance. These are
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
1,439 tests. Postgres checks verified concurrent checklist application and
restricted-source propagation through peer mailbox delivery. Google Calendar
tests verified the Meet request contract with a provider mock. Some broader
Windows tests failed because their Docker executable and `chmod` fixtures
assume POSIX; Linux CI remains the merge gate. These checks do not yet prove
live agent consensus, generated prospect tasks, or an actual Meet link.

Headless component fixtures at `localhost:5455` exercised designer draft
preservation across tabs, checklist application and result saving, local-draft
clearing, and the task Details surface. The final fixture also verified the
Calendar/Meet capability picker and the actual Details-to-Checklist switch,
including retaining Checklist after reload. The checklist checkbox sizing and
an effect that reset the selected tab were corrected after browser review.
These fixtures use mocked API responses;
they supplement the production walkthrough rather than replace it.

## Compaction verification

The sibling `UnlikeOtherAI/deep.agent` repository already exports model-authored
compaction. Its loop invokes it when the host supplies `generateNote`, falling
back to trimming when no compaction hook is supplied. The earlier inspection
missed this existing capability. Its private packages support commit-pinned
Git installation with prepare/prepack hooks; Nessie does not yet consume them.

Nessie's worker already has a separate context-compaction path with a utility
model call, tool-call/result grouping, citation-preservation instructions, and
durable run checkpoints. A Deep.Agent integration must retain those contracts,
including source restrictions and author lineage. Replacing this path with
history trimming would discard capabilities. Verify a versioned shared
compaction contract and its preservation tests before switching the consumer;
no Deep.Agent integration is claimed by this sales-collaboration change.
