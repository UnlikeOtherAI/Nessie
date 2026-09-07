# Sales-agent collaboration verification

This workflow checks that a person can configure a researcher and coordinator,
have them review a small prospect set together, and retain the work in a project.
The default test brief is three Czech hospitality prospects for KiloMayo.

## Evidence and connections

KiloTalk is the primary research source. Its admin is
<https://kilosupport.kilomayo.dev/admin>; its Streamable HTTP MCP endpoint is
<https://kilosupport.kilomayo.dev/mcp>. MCP uses `KILOTALK_MCP_BEARER_TOKEN`,
which is separate from the portal password. Keep credentials in the configured
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
