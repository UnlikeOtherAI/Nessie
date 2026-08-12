# E2E verification: a hardware-diagnostics monitoring agent, built by a user

**Date:** 2026-08-11
**Status:** 10 defects fixed and deployed; the remaining five (PA provisioning parity, two Designer gaps, three connector dead ends) are in flight across three parallel worktrees; 1 blocked on a Ledger token grant
**Target:** production `https://app.nessie.works` (pre-release; database will be wiped before launch)

## Why this exists

"Watch an external system through its MCP, and ping me in a channel when
something needs me" is going to be one of the most common things people do with
Nessie. This document verifies that journey end-to-end **as a user experiences
it** — through the admin UI and through conversational chat — not through the
API. Every defect found on the way gets fixed, not worked around.

The system under test is the KILOMAYO hardware-diagnostics staging server
(`https://hw.kilomayo.dev`), which exposes a 96-tool MCP endpoint at
`/api/v1/mcp` (streamable HTTP, bearer auth).

**Rule of engagement:** Nessie is driven only through its UI (Playwright).
Direct Nessie API calls are used for *observation and diagnosis only* — never to
create or configure the thing being tested. Authentication plumbing (minting a
session token so the browser stays logged in) is exempt: it is not product
control.

## Phase 0 — Access and tooling

- [x] HW staging server reachable; supplied session validated (`/api/v1/me`)
- [x] HW MCP endpoint located: `https://hw.kilomayo.dev/api/v1/mcp`
      (protected resource, SSO `https://sso.kilomayo.dev`, bearer via header)
- [x] MCP handshake verified — `initialize` + `tools/list` return **96 tools**
- [x] Durable HW API key minted (least privilege — 13 read/investigate/record
      scopes; `device:crash`, `database:reset`, `device:restart`,
      `users:manage`, `apikeys:manage`, `files:*` deliberately excluded)
- [x] API key verified against MCP (`whoami` → `kind: "agent"`)
- [x] Nessie production session made durable for the browser session
- [x] Playwright driver working against `https://app.nessie.works`, logged in

## Phase 1 — Build it by clicking (the manual path)

- [x] Create channel `#tech-issues`
- [x] Install the HW MCP connector through the Connectors UI
      (secret submitted once to the encrypted secret store)
- [x] Discovered tools reviewed and activated (58 of 96 approved; 38 destructive left pending on purpose)
- [x] Create the monitoring agent in Agent Designer **by clicking**
- [x] Grant the HW tools to that agent (Designer shows "Connectors (MCP) 58/58")
- [x] Bind the agent to `#tech-issues` (channel Members popup)
- [x] Create the recurring schedule that runs the sweep (interval, 15 min)
- [x] Verify a scheduled run actually executes and reads the HW server
- [x] Verify a real finding lands in `#tech-issues`
- [x] Verify the ping reaches the owner (@mention → alert bell)

## Phase 2 — Build it by chatting (the conversational path)

- [ ] Reach the same outcome through conversation with the Personal Assistant
- [ ] Connector installed conversationally (`connector_*` PA tools)
- [ ] Agent created and bound conversationally
- [ ] Schedule created conversationally
- [ ] Parity assessed: does the chat path reach the same place as the click path?

## Phase 3 — Fix what is broken

- [x] Every defect found is logged below with evidence
- [x] Each design decision is agreed by **Fable** and **Kimix** before implementing
- [x] Fixes implemented on this worktree branch
- [ ] Pushed to `main`, deployed, re-verified in production

## Phase 4 — Judge it as a user

- [ ] The result makes sense from a user's perspective, not just a tester's
- [ ] UI changes reviewed and approved
- [x] Docs updated in the same change
- [ ] Merged to `main` and deployed

## Defect log

| # | Where | What | Severity | Status |
|---|-------|------|----------|--------|
| 1 | Tools / Connectors | MCP tools discovered at a **shared** install scope project as `pending_review`; the worker only exposes `active`; **no route or UI anywhere transitions them**. Every org/project/team/channel-scoped connector was permanently inert. | **Blocker** | Fixed — `POST /api/mcp/tools/status` + review controls on `/agents/tools` + "N tools awaiting review" chip on Connectors |
| 2 | Triggers / channels | A trigger fire posted its kickoff prompt as a visible channel message **attributed to the human owner** (raw JSON payload, "A interval trigger…"), and the agent's finding threaded *under* it — so a monitoring channel showed only plumbing. | **High** | Fixed — kickoff is `role: 'system'`; trigger runs stamp `replyPlacement: 'channel'`; grammar + payload leak fixed |
| 3 | `message_search` builtin | `t."channel_id" IN (${Prisma.join(channelIds)})` sent text params against a `uuid` column → every call failed with Postgres 42883 `operator does not exist: uuid = text`. A default-on builtin, broken for every agent in production. | **High** | Fixed — cast each id, matching the working sibling in `conversation-search.ts` |
| 4 | Personal Assistant | The PA cannot reach parity with the click path: no `channel_create`, no agent creation, no agent→channel binding, no trigger creation. It said so honestly rather than faking it, but a user who does not want to click cannot get there. | **High** | Designed (Fable + Kimix agreed); not yet built |
| 5 | Runs / scheduling | A run **always** posts a message, so a monitoring agent cannot stay quiet; a 15-minute sweep reports "nothing changed" forever. | **High** | Built, then **reverted** — the `conclude_silently` descriptor made the provider return empty completions and failed every trigger run. Design stands; mechanism needs rework |
| 6 | Ledger / embeddings | Production had no `NESSIE_EMBEDDING_*`, so embeddings fell back to the chat provider and 403'd. Fixed the routing — but the Ledger key is then rejected with `token not allowed for jina`, so memory recall and `kb_search` still run without vectors. | **High** | Routing fixed + deployed; **blocked on the Ledger token being granted the jina service** |
| 7 | Triggers / Ledger | Every **scheduler-fired** run fails with `Ledger requires a linked UnlikeOtherAI SSO identity for the originating user`. Manual "Run now" and @mentions work, because they carry the caller's linked identity. The unattended schedule has therefore never delivered on its own. | **Blocker** | **Fixed** — the trigger persists the creator's UOA tuple in `launchOrigin` and re-verifies it against the live link at each fire. Verified: an unattended scheduler run completed in production for the first time |
| 8 | Add MCP server wizard | Transport dropdown offers `stdio` and `ws`, which the server rejects for user-authored connectors (HTTP/SSE only). Dead options in a picker. | Minor | Open |
| 9 | Install form | Scope-id is a raw UUID text box with no picker. Works for `organization` (pre-filled) but is a dead end for project/team/channel scope. | Minor | Open |
| 10 | Connectors, installed scopes | Empty state reads «Pick a catalog entry and click "Install"» while the selected entry is a draft and no Install button exists (it appears only after Publish). | Cosmetic | Open |

### Defect 1 — design agreement

Both consultants independently reviewed the evidence and **agreed on shape D**
(Tools page owns approval, Connectors page is the in-context doorway):

- **Fable** rejected auto-activating shared scopes after finding the gate is
  also the *drift* channel (a re-probe flips a changed tool back to
  `pending_review`), and rejected a single connector-level "approve all" as a
  blanket approval that hides destructive tools.
- **Kimix** ratified, with four corrections that were adopted: put the service
  in `@nessie/mcp-manage` (shared MCP management logic) rather than
  `api/src/services`; reuse the existing `McpInstanceError`
  /`MANAGED_BY_INTEGRATION` instead of a new error vocabulary; keep the new
  schema beside the registry-entry enums, away from the bundle-status block
  that uses a different vocabulary; and prove the fix with a test asserting the
  transition actually satisfies the worker's toolset query — since the defect
  was precisely a green-UI/dead-pipeline gap.

### Defect 2 — design agreement

Both consultants independently reached the same answer, and both rejected the
alternatives:

- **(a) Where the output lands.** Both confirmed a trigger fire is the textbook
  case of `channel` placement — "a standalone contribution to the room, not an
  answer owed to the trigger" — and that it must be stamped *structurally* from
  the fact that it is a trigger run, never judged from content.
- **(b) The kickoff message.** Both chose option A (`role: 'system'`, like the
  Personal-Assistant path already did) over keeping it visible. **Kimix**
  verified it breaks neither the audit trail (`AgentTriggerDelivery` +
  `Run.triggerId` carry provenance; the row persists, it is only filtered from
  rendering) nor cancel/restart/continue (`Run.triggerMessageId` is
  role-agnostic and replays by id). **Fable** added the decisive catch: the
  *batched pending-drain* path in `packages/db/src/thread-serialization.ts`
  creates runs too and sets no placement, so **(a) and (b) must ship together
  and cover the drain** — otherwise a fire landing on a busy thread would reply
  under an invisible root and disappear from the channel entirely. Both also
  flagged the "A interval" article bug and the raw payload dump; the payload is
  kept (it is model-only now, and a webhook fire is useless without it).

A third path neither brief mentioned turned up during implementation and got
the same treatment: `api/src/services/trigger-dispatch.ts` (webhook intake)
created its kickoff as `role: 'user'` with no placement, exactly like the
worker path.

### Defect 4 (PA parity) — design agreement

Both agreed: give the Personal Assistant four provisioning tools —
`channel_create`, `agent_create`, `agent_bind_channel`,
`agent_trigger_create` — each mirroring the REST route's own authorization
rather than inventing a new one, and each delegating to the *same* service
function the route uses (moved into a shared package, never forked — the
existing "mirrored from" comment in `pa-tools/channels.ts` is the Rule-zero-#4
defect not to extend).

On the escalation question both landed in the same place: the boundary is
"could the acting owner click this today", re-derived live per call. The
existing walls already hold — `assertGenericAgentToolPolicyInput` refuses every
`requiresExplicitGrant` key and DeepWater provenance marker, `createAgentRecord`
refuses `agentKind`/`systemManaged`/`delegationMode`, bindings refuse the PA DM,
and a member-created agent is inert until an owner binds/triggers it. Both
explicitly withheld `agent_update`, `agent_delete`, and any DeepWater
grant machinery.

They disagreed on one point: Kimix wanted `agent_create` owner-only; Fable said
member-level for route parity. **Checked in code — Fable is right:**
`POST /api/agents` and `POST /api/channels` carry only `requireActorContext`,
while `POST /api/agents/:id/bindings` adds `requireOwner` + channel membership
+ not-a-PA-DM + `checkPolicy('agent','bind')`. Matching the routes exactly is
the whole point, so create is member-level and bind/trigger are owner-gated.

### Defect 7 (scheduler identity) — design agreement

Both consultants chose **shape B**: capture the creator's immutable UOA tuple
(`{subject, organizationId, teamId, tokenVersion}`) into the trigger's
server-owned `launchOrigin` while a session exists, replay it at fire time, and
re-verify it against the live `ProductAccountLink` exactly as a session is
verified. Both rejected reading the link's `activeOrgId`/`activeTeamId`
instead — the docs call those non-authoritative last-seen metadata, and signing
background work into whatever workspace someone last looked at is the bug that
invites.

Fable added the observation that settles it: `buildSubjectAssertion` never uses
a live user credential — it is Nessie's own RS256 assertion over
`{sub, tv, active}` — so replaying a captured tuple is cryptographically
identical to a live session, and every fail-closed gate is source-agnostic.
Fable also **corrected Kimix on the backfill**: Kimix proposed a one-off script
seeding the tuple from the link's `active*` fields, which would have
reintroduced exactly the non-authoritative source both had just rejected. No
backfill was written; the one pre-existing trigger errored once with the
recreate message and moved to `status: error`, which is the intended path.

### Agent Designer's own chat (the third build route)

The Designer has a **Design Assistant** panel — "I can control anything on this
form" — which is a distinct route from both clicking and the Personal
Assistant DM. Tested last, and it was **dead on this deployment**: it sent a
hardcoded `gpt-5-mini` to whatever provider is configured, so every message
returned `403 gpt-5-mini is not allowed for deepseek`. Fixed (defect 13) by
reading the deployment's own chat model, with `NESSIE_DESIGNER_MODEL` kept as
an explicit cheap-model override.

With that fixed it works well: from one sentence it set the name and role,
wrote a system prompt citing the real connector tools
(`sites_list` → `site_printers` → `printer_get` + `printer_observations`) with
"do not cry wolf on a single blip" guidance, and selectively enabled **7 of the
58** connector tools — the printer-relevant ones.

Two gaps remain, both open:

- It never sets the **model**, so Create stays disabled after the assistant
  says it is done.
- The disabled Create button gives **no reason**. A user is told the form is
  configured and then finds a dead button with nothing explaining why.

### Later rounds — agent voice and watch behaviour

| # | What | Status |
|---|------|--------|
| 9 | Agents wrote encyclopaedia-length replies. "Concise" was already in the base prompt and did not work — it names a quality, not a shape. Replaced with a default *form* (lead with the answer, one short paragraph, structure only for genuinely structured content, go long only when asked). Prompt guidance, never an output cap. | Fixed |
| 10 | An agent could not react — 👍 as a complete response only existed as a pre-run engagement decision, described narrowly ("thanks/ok/noted"). Widened it, and added a `react` builtin so an agent uses the same emoji buttons a person does. An emoji typed into a reply is still a reply, which is why post-processing message text was rejected. | Fixed |
| 11 | Nothing showed which message an agent had picked up. A run now paints 👀 on it, cleared at the terminal status transition so no path can forget and a crash cannot strand it. | Fixed |
| 13 | The Agent Designer's Design Assistant sent a hardcoded `gpt-5-mini` to a DeepSeek deployment — `403`, panel unusable. Now uses the deployment's chat model (`ModelClient.chatModel`). | Fixed |
| 12 | A recurring watch posted a new "nothing changed" every sweep. It now keeps one rolling status line, edited in place with a `checked N× · last hh:mm` counter, reset by any newer visible message. | Fixed |

Verified in production on 2026-08-12: three quiet sweeps folded into one row
(`runCount: 3`, edited in place, rendered as "checked 3× · last 12:55 AM");
after a human message the next sweep started a fresh row at 1.

## Notes

- HW MCP tool count (96) is far above `NESSIE_MCP_INLINE_TOOL_LIMIT` (12), so
  this exercises the deferred-toolset path (`mcp_find_tools` →
  `mcp_load_tools`) rather than inlining every schema. That is the realistic
  case for a large third-party MCP and is explicitly in scope.
- Live HW data at time of writing includes open `Device offline` warning alerts
  across several sites, so the agent has genuine findings to report.
