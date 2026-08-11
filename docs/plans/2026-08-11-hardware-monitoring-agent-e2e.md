# E2E verification: a hardware-diagnostics monitoring agent, built by a user

**Date:** 2026-08-11
**Status:** in progress
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
| 4 | Add MCP server wizard | Transport dropdown offers `stdio` and `ws`, which the server rejects for user-authored connectors (HTTP/SSE only). Dead options in a picker. | Minor | Open |
| 5 | Install form | Scope-id is a raw UUID text box with no picker. Works for `organization` (pre-filled) but is a dead end for project/team/channel scope. | Minor | Open |
| 6 | Connectors, installed scopes | Empty state reads «Pick a catalog entry and click "Install"» while the selected entry is a draft and no Install button exists (it appears only after Publish). | Cosmetic | Open |

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

## Notes

- HW MCP tool count (96) is far above `NESSIE_MCP_INLINE_TOOL_LIMIT` (12), so
  this exercises the deferred-toolset path (`mcp_find_tools` →
  `mcp_load_tools`) rather than inlining every schema. That is the realistic
  case for a large third-party MCP and is explicitly in scope.
- Live HW data at time of writing includes open `Device offline` warning alerts
  across several sites, so the agent has genuine findings to report.
