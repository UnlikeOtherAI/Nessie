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

For real-provider testing before deployment, follow
[local CTO verification](docs/testing/local-cto.md).

Agent response length is prompt-guided rather than application-capped; follow
the run-budget standard linked from `AGENTS.md` for provider protocol limits.

Jev channel decisions are configured in Channel settings or through the Personal
Assistant's `channel_list` / `channel_update` tools. Read
[the channel policy standard](docs/standards/channel-decision-policy.md) and
[its browser evaluation](docs/testing/channel-decisions.md) before changing them.

Executor pairing, independent account/server connections on each platform, and live account-menu presence follow [docs/executor-pairing.md](docs/executor-pairing.md) and [docs/executor-protocol/management.md](docs/executor-protocol/management.md), including their browser verification.

The shared macOS/Windows console and machine-only, per-team resource permissions follow [local executor controls](docs/executor-local-controls.md).
Direct machine access from private agent chat and its self-reminders follows [executor sharing](docs/standards/executor-sharing.md); named internal links and `nessie_link` follow [agent voice](docs/standards/agent-voice.md).
Authorized executor access has no additional private-conversation write veto; output disclosure still follows [the disclosure standard](docs/standards/disclosure-boundaries.md).

Sequential Task Sets, their native agent tools and the configured
`serve-ollama-search-mcp` executor bridge follow
[docs/standards/task-sets.md](docs/standards/task-sets.md).

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
- **Conversational Agent Designer grants** act as the live requesting member;
  protected policy keys stay closed to generic updates, and DeepWater remains
  an atomic bundle whose revocation waits for that agent's unlaunched briefs
  and any open launcher run. Read
  [`docs/plans/2026-09-20-agent-designer-capabilities-and-output-recovery.md`](docs/plans/2026-09-20-agent-designer-capabilities-and-output-recovery.md).

## Notes specific to Claude Code

- Project peer tools and copied ticket checklists are covered by
  [the collaboration standard](docs/standards/global-agents.md) and
  [the sales verification walkthrough](docs/testing/sales-agent-collaboration.md).
- **Verification is Playwright, headless, against this worktree's admin port** —
  `http://localhost:5455` unless it set `NESSIE_ADMIN_PORT`.
  Every UI change is screenshotted and confirmed rendering before the work is
  considered done — see [`AGENTS.md`](AGENTS.md) → "Verification". Do not ask a
  person to check a screen you can open yourself.
- **Project usability browser coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:project-usability`.
  This is a manual local suite using its fixed-port lifecycle harness.
- **Mailbox onboarding browser coverage:** run
  `pnpm --filter @nessie/admin test:e2e:mailbox-onboarding` manually. It uses
  the managed admin lifecycle. It walks the connect ladder — password, one mail server, the one
  leg still missing, then every field — and asserts the posted payload as well
  as the screen, because a form that posts an untyped port looks identical and
  silently disables the server-side sweep.
- **Document-window browser coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:document-window`. Not in
  CI — it owns its servers through the navigation lifecycle, so give it ports
  of its own (`NAV_E2E_API_PORT` / `NAV_E2E_ADMIN_PORT`) beside a running dev
  pair. It pins the open gesture, which a settled screenshot cannot show: the
  web opens a document on the tap that selects it, the desktop shell takes two
  and the first one must open *nothing*. It also walks
  `/documents/<spaceId>/<pageId>` — the address the shell points a new window
  at — and asserts the admin shell is absent from it. The shell is simulated by
  publishing `__nessieDesktopPlatform`, the way the real init script does.
- **Member-management browser coverage:** run
  `pnpm --filter @nessie/admin test:e2e:member-management`. An explicitly flagged manual build includes
  its fixture in the preview build; details and cache rules are in
  [`docs/testing/member-management-e2e.md`](docs/testing/member-management-e2e.md).
- **Private-conversation disclosure browser coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:disclosure` after
  building `@nessie/mock-llm`. Run it locally on fixed ports; details and limits are in
  [`docs/testing/private-conversation-disclosure.md`](docs/testing/private-conversation-disclosure.md).
- **Agent-conversations browser coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:agent-conversations`.
  Run it locally on fixed ports. It brings up its own scripted inference endpoint
  (`admin/e2e/agent-conversations/mock-server.mjs`) because the isolation proof
  reads that server's request log. It covers the DM rail, two isolated
  conversations named by their first message, the one-empty-at-a-time rule
  behind the "New conversation" button, the rename doorway, an ordinary
  room's own doorway and a two-agent room's agent strip, and a ticket's work
  threads folded under Tickets at every width with their wake rows, the row a
  cancelled reminder leaves, and the read-only line for a room member who
  cannot edit the board, and a document trigger's review threads folded under
  Documents the same way; two assertions
  deliberately pin known gaps and say so in their own message. It starts its
  own API and admin, on `NAV_E2E_API_PORT` / `NAV_E2E_ADMIN_PORT` when set.
- **Agent proposal card coverage:** run
  `pnpm --filter @nessie/admin test:e2e:agent-proposal-card`. A pure fixture
  suite — it drives the real card renderer over a stubbed presenter, so it
  needs no database. The manual project-usability lifecycle runs it after the
  app-connect-scope suite. It pins the Agent Designer's standard proposal
  card: name and role, the three-line description, where the agent lives, the
  model dropdown, the tool/app fold that arrives closed, and a ticket-driven
  agent's "Starts work when" and "Runs on" rows — its machines by name only
  on their owner's own card, otherwise "a machine its owner confirms" — and
  the line saying one machine-access confirmation follows.
- **Android shell bottom-edge coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:android-dock`. It drives
  the admin with the Android shell's own globals and its published dock
  clearance, at a tablet viewport, and pins the contract the tablet layout
  broke on: `main` keeps its full height so full-height columns reach the
  window floor, while the composer and a page body each clear the dock by
  exactly the published value and no more. The same screen without the shell
  globals is measured beside it, which is the acceptance test for "the web and
  the iPhone are untouched". Not in CI — it owns its servers through the
  navigation lifecycle, so give it ports of its own (`NAV_E2E_API_PORT` /
  `NAV_E2E_ADMIN_PORT`) beside a running dev pair. The rule it defends is in
  [`docs/navigation/native-shell.md`](docs/navigation/native-shell.md).
- **Browser UI suites are manual local checks, outside GitHub Actions.**
  Use the existing `pnpm --filter @nessie/admin test:e2e:<suite>` commands.
  No browser workflow is dispatched or required before merge.
- **CI delivery:** every CI run that builds the production images saves them
  (main for seven days, a branch for one) for gated promotion without
  rebuilding; [redeploying](docs/deployment/redeploying.md) defines the contract.
  CI splits the package suites into seven test legs on their own runners and
  databases through `scripts/ci-tests.mjs`, behind the required `Test` check;
  [testing](docs/standards/testing.md) defines the local verification path and
  preserves ordinary shared-database test ordering. The Linux Desktop Bundle
  and Windows Native checks run in the separate Desktop CI workflow.
  Worker-only tests also build the real executor bridge fixture dependency.
  The Linux desktop workflow generates Prisma, builds `@nessie/executor` with
  its workspace dependencies, and prepares the packaged runtime before Tauri
  builds, matching Windows.
- **Preview fixtures stay out of production bundles.** Register the fixture
  in `admin/vite.config.ts` behind its `NESSIE_<NAME>_E2E_FIXTURE` flag, set
  that flag for a manual preview build, and list it in `@nessie/admin#build`
  `env` in `turbo.json`. Verify with `NAV_E2E_ADMIN_MODE=preview` against
  that build. The executor flags are in [their browser guide](docs/testing/executor-attention.md).
- **Channel agent-control coverage:** run
  `pnpm --filter @nessie/admin test:e2e:channel-agent-controls`. A pure fixture
  suite — it drives the real members popup over each answer to
  `ChannelRecord.viewerCanManageAgents`, so it needs no database. The manual harness runs it in
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
- **Ticket dialog coverage:** run
  `pnpm --filter @nessie/admin test:e2e:task-dialog`. A pure fixture suite
  (`NESSIE_TASK_DIALOG_E2E_FIXTURE`) that drives the real `TaskDialog` over a
  stubbed client; The manual harness runs it after the visibility-affordance one. It pins the
  layout Ondrej asked for — Documents directly under the Markdown description
  in the left column, then Attachments and Comments, labels as a compact token
  field on the right — plus the label keyboard, the read-only mirror and
  viewer states, the phone stack, the board's own Labels tab, and removing an
  attachment with a reason: the confirm (shot 12) and the removed row that
  still shows its uploader, remover, reason and Download (shot 13), and the
  full-size viewer opened from the ticket's Attachments or a comment's file
  sitting on the blocking layer and owning Back, so Back closes it and leaves
  the ticket open (shots 14 and 15, phone). With `&work=` it shots an agent's
  work chip in each T1 state — working, with no thread link for a reader who
  may not open it, parked, parked after a move back that did not resume it,
  stopped at its wake limit, done — its work history opened, the move that
  started nothing, the card's avatar and state dot, and the chip on a phone
  (shots 16–18), and at 1280 and 390 px the agent's pending reminder with
  Cancel for a board editor, pressed and gone, a reader's without Cancel, and
  an open question (shots 19), and the chip's machine states — queued at its
  position, paused for an offline machine since it was last heard from,
  waiting for machine access, stopped at an hours or spend limit, a wake that
  ran without a machine in words, queued again for another machine after its
  own stayed away, back online, woken by its coding session's turn, and their
  history lines (shots 20 on; the rules are in
  [`docs/standards/ticket-work.md`](docs/standards/ticket-work.md) and
  [`docs/standards/ticket-work-machine-access.md`](docs/standards/ticket-work-machine-access.md)). The
  real-stack half — a label following a ticket to another board by name, a
  removal persisting and still downloading — is in the project-usability
  suite's `ticket-activity.mjs`. The rules are in
  [`docs/standards/ticket-activity.md`](docs/standards/ticket-activity.md).
- **Tool screenshot coverage:** run
  `pnpm --filter @nessie/admin test:e2e:tool-screenshots`. A pure fixture suite
  (`NESSIE_TOOL_SCREENSHOTS_E2E_FIXTURE`) run manually: a
  local program's screenshots as thumbnails in the thought-process dialog and
  the agent page's tool execution log, the original in the attachment viewer
  (over the dialog in the blocking layer), at 1280 and 390 px. The rules are in
  [`docs/standards/executor-local-mcp.md`](docs/standards/executor-local-mcp.md).
- **DeepWater research coverage:** run
  `pnpm --filter @nessie/admin test:e2e:research-brief`. A pure fixture suite
  (`NESSIE_RESEARCH_BRIEF_E2E_FIXTURE`) over the real brief dialog, research
  card, Knowledge › Research and `/apps/deep-water` hero; The manual harness runs it after the
  agent-triggers one. The runner plays the server through `window.__research`
  (the planner answering, a launch landing, a revision conflict, DeepWater's
  progress pushes as `integration.run.updated` frames) and pins the whole
  person brief, a running card streaming each push with no request between
  two, the dialog leaving "replying" as its turn lands, the artifact actions
  and their clipboard fallback, an
  older card's action, an agent's read-only brief and its discard (accepted,
  then settled by `cancelSettles`), the not-ready doorways and a verdict the
  admin cannot read, the owner's cancel of a research that blocks turning
  DeepWater off (requested, still refusing, then stopped; refused by DeepWater
  through `cancelRefused` and offered again; unseen by an owner who may not
  read it), Knowledge › Research with a research from before briefs, a second
  page walked back and an empty first page with more to come, and the admin's
  own addresses — a brief on a reply thread's and the Threads inbox's address,
  and a question handed from a screen with no brief host (`/elsewhere`) that
  Back and Forward never reopen. The server stub is `fixture-server.ts`. The
  rules are in
  [`docs/standards/deepwater.md`](docs/standards/deepwater.md) → "Research
  briefs — the admin".
- **DeepWater research real-stack coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:research-brief-real`.
  The same components against the real API, embedded worker and database:
  the composer's Research button in a channel, a reply thread, a person drawer
  and a Threads inbox card, a research card opening its brief through
  `?research=`, a person's own brief read from the brief API, a refused reply
  saying why, Ledger's launch reaching the open dialog and the room live, a
  signed DeepWater progress event posted to the real receiver moving the
  room's card live, and Knowledge › Research. Ledger cannot be doubled on the wire (the pinned egress
  refuses loopback, and brief readiness needs a UOA signer), so its answers are
  played through the watch's own projection and realtime announcer
  (`real-stack-ledger.mjs`), and opening a new brief from a composer stays the
  fixture suite's. It starts and stops its own API and admin and never adopts a
  running pair. Run it manually on this worktree's free ports.
- **Overlay layer coverage:** run
  `pnpm --filter @nessie/admin test:e2e:overlay-layer`. A pure fixture suite
  over the real navigation stack, in the same lifecycle after the task-dialog
  suite. It pushes Board → Settings from inside an open ticket dialog without
  closing it, on `split` and `single`, and pins that the dialog then leaves
  paint, focus, the accessibility tree and Back — and is the same node, with
  what was typed, after Back. A nested stage's dialog is walked too, and a
  route pushed over an open stage owns Back rather than the stage beneath it.
  The rule is in
  [`docs/navigation/overlays.md`](docs/navigation/overlays.md).
- **Agent triggers coverage:** run
  `pnpm --filter @nessie/admin test:e2e:agent-triggers`. A pure fixture suite
  (`NESSIE_AGENT_TRIGGERS_E2E_FIXTURE`) that drives the real
  `TriggerEditorDialog`, `TriggerTypePicker`, `KanbanBoard`, `TriggerDetail`
  and the documents Finder over a stubbed client; The manual harness runs it in the
  project-usability lifecycle after the overlay-layer suite. It pins the
  picker (the five released types plus Ticket change and Document change for
  an agent, and no agent-only type for a workflow), a ticket
  trigger's form (public project channels only and why, the board and
  columns picked, an end column that cannot start work), a second pickup on a
  column refused **on the pickup field** and the typed config the corrected
  create posts (its quiet wake on, off and set, and the hours to wait for an
  offline machine), the board's "Moving here starts work" badge at the head of a
  track still aligned with its neighbours, card dots and the column menu on
  every column but Done that opens the editor prefilled with its type fixed,
  and a ticket trigger's page
  with its named facts and deliveries in words (a run the standing-policy
  binder bound no machine to included) and its Machine access section in
  every state — not set up, read-only for an owner who is not the author,
  awaiting confirmation, live with the machines named only to the author,
  suspended, ended by whom — the author's setup form refusing a machine for
  each reason, the prepare it posts, a server refusal, the one card with its
  password review, and End, where a card left unconfirmed is after a reload,
  the editor's warning before a save pauses live access and the page's
  notice after it, and the author's read-only trigger page; a document
  trigger's form
  (the project's Documents space chosen, a team-only space disabled), a
  refusal landing on the space field, the exact typed config its create
  posts, and its page with each delivery in words; and in a project's Docs
  tab the "Reviewed by CTO · v5" and "Sent to CTO for review · v2" row
  badges from one read per folder (a thread link only for its readers),
  "Open review thread", and "Tell an agent
  when this changes…" on a folder or document — never a spreadsheet, never
  for a viewer the Triggers routes refuse — opening the editor prefilled —
  at 1280 and 390 px (the phone paged to the columns that matter). The rules
  are in [`docs/standards/ticket-work.md`](docs/standards/ticket-work.md) and
  [`docs/standards/document-triggers.md`](docs/standards/document-triggers.md).
- **Browser Cloud usability coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:browser-cloud`.
  Run it manually through the managed lifecycle on this worktree's free ports.
- **Spreadsheets browser coverage:** run
  `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:spreadsheets` — two real
  browsers and two real accounts on one API, covering a live batch, the
  presence overlay and draft ghost, the structural rebase, the offline queue
  and phone touch selection. The optional aggregate runner is `node admin/e2e/spreadsheets/ci.mjs`. Both entries start and stop their own API and
  admin and **never adopt a server that is already listening** — a run that
  adopted one drove another worktree's API and seeded into the wrong database
  in silence — so free this worktree's pair before running it, or point the run
  at ports of its own with `NAV_E2E_API_PORT` / `NAV_E2E_ADMIN_PORT`. The invariants it
  defends are in
  [`docs/standards/spreadsheets.md`](docs/standards/spreadsheets.md).
- **Full-width tab bar geometry:** run
  `pnpm --filter @nessie/admin test:e2e:tabbar-full` after touching
  `.tabbar-shell*` or adding a `<TabBar fullWidth />` call site. It needs no
  API or database, and its fixture must gain the new call site's container —
  the rule it guards is in
  [`docs/standards/design-system.md`](docs/standards/design-system.md).
- **Ports:** API `5454`, admin `5455` by default. When they are busy — another
  worktree is almost always the reason — give this worktree its own pair with
  `NESSIE_API_PORT` / `NESSIE_ADMIN_PORT` (environment, or the repo root
  `.env`) rather than killing the holder or verifying against its server.
  `predev` names the holder and the variable to set. Within a worktree the pair
  stays put once the servers are up; the full rule is in
  [`AGENTS.md`](AGENTS.md) → "Ports".
- **Production promotion uses the exact-SHA gate:** Deploy promotes the newest
  `main` commit CI has verified — by its own successful trusted main CI run, or
  by a successful branch run on its identical tree — the tip when it is
  verified, otherwise the newest verified ancestor — on a push to `main`, a
  green main CI run and manual dispatch alike. A run that promotes nothing says so in its title and summary, and a
  stall fails the run. Read
  [`docs/deployment/redeploying.md`](docs/deployment/redeploying.md)
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

- Executor terminal sessions use tmux on Mac/Linux and ConPTY on Windows; agent writes send exact text or a named key; read [the session guide](docs/executor-protocol/terminal-sessions.md) for setup, sharing, agent tools and native verification.

Executor sharing is direct: people receive use or admin access, projects and the current team receive use access; read [executor sharing](docs/standards/executor-sharing.md) before changing it.
