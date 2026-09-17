# Nessie — Claude Code

Multi-tenant, self-hosted agentic work platform. Organisations host their own
Nessie instance; users collaborate in Organisation → Team → Project →
Channel ([docs/standards/team-model.md](docs/standards/team-model.md)),
with RBAC, approval gates, an audit trail, a token-cost ledger,
MCP connector management, triggers/scheduling, video calling, and human work
distribution.

## Read [AGENTS.md](AGENTS.md) before you do anything

[`AGENTS.md`](AGENTS.md) is the authoritative standards file and the project
map: Rule zero, workflow and required CI checks, ports, deployment, and the
invariants that apply wherever you are working. It is **not** imported into
this file — open it.

> **Rule zero — a capability is not done until a person can reach it.** A
> feature nobody can navigate to counts as unfinished. The four checks and the
> history behind each are in [`AGENTS.md`](AGENTS.md) → "Rule zero".

## Per-subsystem rules live in `docs/standards/`

One file per subsystem, deliberately **not** loaded into every session.
[`AGENTS.md`](AGENTS.md) → "Architecture" routes to them: each entry names the
invariant in a sentence and links the file that states it in full.

That sentence is a signpost, not a specification. It tells you whether a rule
is in play; it deliberately omits the identifiers, the failure the rule was
written after, and the corollaries that make it followable. **When your change
touches a routed area, open the linked file before writing code.**

When a rule changes, its standards file changes in the same turn. The routing
sentence changes only if the invariant itself did.

- **Connected-mail chat review and drafts** reuse the viewer-scoped `/mail`
  surface and its approval gate; read
  [`docs/standards/connected-mailboxes.md`](docs/standards/connected-mailboxes.md).
- **Private browser access, human control, and selected-site Chrome import**
  have their own explicit-grant contract; read
  [`docs/plans/2026-09-07-private-browser-access-and-import.md`](docs/plans/2026-09-07-private-browser-access-and-import.md).

## Notes specific to Claude Code

- Project peer tools and copied ticket checklists are covered by
  [the collaboration standard](docs/standards/global-agents.md) and
  [the sales verification walkthrough](docs/testing/sales-agent-collaboration.md).
- **Verification is Playwright, headless, against `http://localhost:5455`.**
  Every UI change is screenshotted and confirmed rendering before the work is
  considered done — see [`AGENTS.md`](AGENTS.md) → "Verification". Do not ask a
  person to check a screen you can open yourself.
- **Project usability browser coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:project-usability`.
  The on-request Browser Suites workflow runs it in Navigation Transitions through a fixed-port lifecycle harness,
  between the navigation and independent connected-mail suites.
- **Mailbox onboarding browser coverage:** run
  `pnpm --filter @nessie/admin test:e2e:mailbox-onboarding`. CI runs it in
  Navigation Transitions after the connected-mail suite, on the same admin
  lifecycle. It walks the connect ladder — password, one mail server, the one
  leg still missing, then every field — and asserts the posted payload as well
  as the screen, because a form that posts an untyped port looks identical and
  silently disables the server-side sweep.
- **Member-management browser coverage:** run
  `pnpm --filter @nessie/admin test:e2e:member-management`. CI alone includes
  its fixture in the preview build; details and cache rules are in
  [`docs/testing/member-management-e2e.md`](docs/testing/member-management-e2e.md).
- **Private-conversation disclosure browser coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:disclosure` after
  building `@nessie/mock-llm`. The on-request Browser Suites workflow runs it first in Navigation Transitions on
  the same fixed ports; details and limits are in
  [`docs/testing/private-conversation-disclosure.md`](docs/testing/private-conversation-disclosure.md).
- **Agent-conversations browser coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:agent-conversations`.
  The on-request Browser Suites workflow runs it in Navigation Transitions after the connected-mail suite, on the
  same fixed ports. It brings up its own scripted inference endpoint
  (`admin/e2e/agent-conversations/mock-server.mjs`) because the isolation proof
  reads that server's request log. It covers the DM rail, two isolated
  conversations named by their first message, the one-empty-at-a-time rule
  behind the "New conversation" button, the rename doorway, an ordinary
  room's own doorway and a two-agent room's agent strip; two assertions
  deliberately pin known gaps and say so in their own message.
- **Agent proposal card coverage:** run
  `pnpm --filter @nessie/admin test:e2e:agent-proposal-card`. A pure fixture
  suite — it drives the real card renderer over a stubbed presenter, so it
  needs no database. CI runs it in the project-usability lifecycle, after the
  app-connect-scope suite. It pins the Agent Designer's standard proposal
  card: name and role, the three-line description, where the agent lives, the
  model dropdown, and the tool/app fold that arrives closed.
- **The browser suites run on request, not on every push.** They live in
  `.github/workflows/browser-suites.yml`; start them with
  `gh workflow run browser-suites.yml --ref <branch>` or from the Actions tab.
  Nothing runs them automatically, so a branch that touches the admin shell,
  navigation surfaces, the mailbox or the documents browser should be given a
  run before it merges.
- **A CI browser fixture takes three edits, not one.** Navigation Transitions
  serves a *preview build* (`NAV_E2E_ADMIN_MODE: preview`), not the dev
  server, so a new `admin/e2e/<name>/index.html` is not served at all unless
  **(1)** it is a rollup input in `admin/vite.config.ts` behind its own
  `NESSIE_<NAME>_E2E_FIXTURE` flag, which keeps it out of release bundles,
  **(2)** that flag is set on the job in `.github/workflows/browser-suites.yml`, and
  **(3)** the flag is listed under `@nessie/admin#build`'s `env` in
  `turbo.json`. Miss (3) and CI restores a cached bundle built without the
  fixture, which fails exactly like missing (1) — the flag has to be in the
  build's hash or it changes nothing. All of this passes locally either way,
  because `startAdmin()` defaults to the dev server. Verify a new suite with
  `NAV_E2E_ADMIN_MODE=preview` against a build made with the flag, and confirm
  the flag actually changes `admin/dist`, before trusting it.
- **Channel agent-control coverage:** run
  `pnpm --filter @nessie/admin test:e2e:channel-agent-controls`. A pure fixture
  suite — it drives the real members popup over each answer to
  `ChannelRecord.viewerCanManageAgents`, so it needs no database. CI runs it in
  the same lifecycle, after the proposal-card suite. It pins that placing an
  agent is owner-or-admin standing while adding a person is any member of the
  channel, including the case where those pull apart: an admin outside the room
  keeps the agent controls and loses the person Add.
- **Visibility affordance coverage:** run
  `pnpm --filter @nessie/admin test:e2e:visibility-affordances`. Also a pure
  fixture suite, in the same lifecycle after the agent-control one. It renders
  the lock — derived from `visibility === 'protected'`, because the wire
  carries no `locked` field — and all three composer states, including the one
  a unit test cannot show: an organisation admin who may open a protected
  room's settings, may not post in it, and is told why.
- **Browser Cloud usability coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:browser-cloud`.
  The on-request Browser Suites workflow runs it in that same managed Navigation Transitions lifecycle before the
  project usability suite.
- **Spreadsheets browser coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:spreadsheets` — two real
  browsers and two real accounts on one API, covering a live batch, the
  presence overlay and draft ghost, the structural rebase, the offline queue
  and phone touch selection. CI runs `node admin/e2e/spreadsheets/ci.mjs` last
  in Navigation Transitions. Both entries start and stop their own API and
  admin and **never adopt a server that is already listening** — a run that
  adopted one drove another worktree's API and seeded into the wrong database
  in silence — so free `5454`/`5455` before running it. The invariants it
  defends are in
  [`docs/standards/spreadsheets.md`](docs/standards/spreadsheets.md).
- **Full-width tab bar geometry:** run
  `pnpm --filter @nessie/admin test:e2e:tabbar-full` after touching
  `.tabbar-shell*` or adding a `<TabBar fullWidth />` call site. It needs no
  API or database, and its fixture must gain the new call site's container —
  the rule it guards is in
  [`docs/standards/design-system.md`](docs/standards/design-system.md).
- **Ports are non-negotiable:** API `5454`, admin `5455`. Never start either on
  another port to work around a conflict.
- **Production promotion uses the exact-SHA gate:** Deploy resolves the current
  `main` tip only after successful trusted main CI, including manual dispatch.
  Read [`docs/deployment/redeploying.md`](docs/deployment/redeploying.md)
  before changing deployment automation.
- **Worktrees are mandatory** and the main checkout stays on `main`. **`main` is
  protected — every change lands through a pull request and only a green one can
  merge**, but no human approval is needed: merge as soon as CI passes. Full
  rule, including the required checks and the clean-up step, in
  [`AGENTS.md`](AGENTS.md) → "Workflow".
- **Voice** is a secondary control surface, not the primary interface — that is
  the admin web UI (`admin/`). Two independent things carry the name: calling
  the Personal Assistant (Gemini Live, browser + iPhone,
  [`docs/standards/voice-calling.md`](docs/standards/voice-calling.md)) and an
  older, architecturally separate OpenAI-Realtime companion in `macos/`.
