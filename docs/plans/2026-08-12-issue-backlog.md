# Issue backlog — owner-reported, worked one by one

Durable, append-only log of issues the owner reports. Nothing is removed; items
move status in place so the record of what was asked survives. Newest task is
appended at the bottom of the table; detail sections follow in the same order.

Status: `todo` · `design` (proposal round out) · `doing` · `blocked` · `done`

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Archive/unarchive for channels + projects at every level | doing | Model decided (see Decisions); writing consolidated spec |
| 2 | Channel names always lowercase-hyphenated, no special chars | doing | chokepoint + both dialogs done; verification pending |
| 3 | No member selector in a 1:1 DM (API + UI) | doing | API done; UI pending. See conflict note under task 4 |
| 4 | `+` on Direct Messages opens a compose screen, not "Invite a user" | design | Kimix design consult running |
| 5 | Dialog dismisses when a drag started inside ends on the scrim | doing | Shared hook written; applying across 18 dialogs |
| 6 | Starred section: self-DM star state, agent DM shown as `#`, two rows active | todo | Three defects, one sidebar surface |
| 7 | Channel tabs: drop Runs, drop Info, composer only on Messages | doing | Delegated |
| 8 | Deep Water launcher: Light/Standard/Heavy/Custom + language multi-select | blocked | Blocked on task 9 (Ledger parity) for the language set |
| 9 | **Ledger**: bring MCP `research_start` to parity with DeepWater's REST config | done (unmerged) | `claude/deepwater-mcp-parity` @ `1f6d8f6`, pushed, NOT merged |
| 10 | Nessie consumes Ledger parity: languages, real tiers, recency, report title | todo | Blocked until task 9 merges + deploys |

---

## 1 — Archive / unarchive, every level

> "There is no way of archiving. I don't want to delete it. Any channel or
> project we should only archive so that we can potentially unarchive them…
> It needs to work on every level."
>
> Follow-up: "there is a channel that is in the channel settings… there's
> Archive and Delete, so I guess we can delete projects, but we really need to
> make sure that we have the right permissions to do that. Also, we need to make
> the system consistent. You know how we handle channels. We should handle
> projects as well."

Brief: [2026-08-12-archive-unarchive-brief.md](2026-08-12-archive-unarchive-brief.md).
Proposals: `-fable.md`, `-kimix.md`, `-sol.md` (all three delivered).

### Decisions (owner-approved 2026-08-12)

All three proposals converged on the model, so it is settled:

1. **Archive is one lifecycle state**, `archivedAt`, identical semantics on
   every object type. Not per-type, not a storage tier.
2. **No cascade stamping.** Archiving a project stamps the project only.
   Descendants are *effectively archived* through the ancestor and keep their
   own flags, so restoring returns exactly the prior world — a channel someone
   archived deliberately stays archived. State-cascade and today's
   block-on-non-empty both rejected.
3. **Delete — owner picked the Fable/Sol model.** Delete is permanent and real,
   allowed **only on an object that is already archived**, **org owner only**,
   behind a typed confirmation naming the object and its blast radius. There is
   **no retention timer** — Kimix's 30-day auto-purge was rejected: an
   invisible deadline on archived data is the opposite of "I don't want to
   delete it". Archive keeps history indefinitely.
4. **Archive/unarchive permissions follow the object's existing manage rule**,
   not the org owner alone: channels keep `canManageChannel` (channel/org/team
   owner+admin); projects get a mirrored `canManageProject`. The server returns
   capability flags so the UI renders only actions the caller may take — never a
   Restore button that 403s.
5. **Owning surface `/archive`**, absorbing today's archived list under
   Settings → Channels. In-context doorways everywhere archived items can be
   produced.
6. **The lying Delete button goes.** The channel dialog's danger-styled "Delete"
   that silently archives is replaced by an honest Lifecycle section.
7. **First slice: projects + channels** — the two the owner named. Teams,
   tasks, knowledge pages, agents, triggers and workflows follow the same
   pattern afterwards. Threads get no independent switch (a channel owns one
   durable thread; archiving it would leave an active channel with no feed).

Facts established while briefing:

- `Channel.archivedAt` exists; `Project` has **no** archive field; `Team` and
  `Thread` have none either. `Task.archivedAt` and `KnowledgePageStatus.archived`
  exist as unrelated half-systems.
- **The channel "Delete" button is not a delete.** `handleDelete`
  (`admin/src/components/shared/ChannelSettingsDialog.tsx:76`) calls the archive
  mutation, and `DELETE /api/channels/:channelId` is itself only a soft archive.
  Archive and Delete are one action with two labels.
- `DELETE /api/projects/:projectId` **is** a hard delete, org-owner-only, and
  refuses with 409 `PROJECT_NOT_EMPTY` until every channel is gone.
- Permissions are asymmetric: channel disposal → `canManageChannel`
  (channel/org/team owner+admin); project disposal → org owner only.

## 2 — Channel names are always slugs

> "names of channels should be all lowercase always… on creation as well as on
> edit and everything. Everything has to be converted to lowercase, with spaces
> being replaced by hyphens and no special characters."

Done so far:

- One canonical rule in `packages/schemas/src/channel-name.ts` (`toChannelSlug`
  for save, `toChannelNameInput` for typing) replacing three byte-identical
  private copies (two admin, one api).
- `validateChannelLabel` now returns `label = slug`, so the single server-side
  chokepoint every write passes through (create, rename, DM promotion) can no
  longer persist a non-conforming name.
- Create + settings dialogs normalize as you type, canonicalize on blur/submit,
  and state the rule under the field. The create dialog's separate disabled
  "Slug" field is gone — with `label === slug` it showed the same string twice.

Open: existing rows are not backfilled — a channel named "Design Reviews" keeps
that label until someone renames it. Decide whether to migrate. Playwright
verification pending.

## 3 — A 1:1 DM has no member selector

> "when I'm in a one-on-one chat, either with myself or with any other member or
> agent, I can still see a members selector in the top right corner. This needs
> to be disabled on both the API level and in the UI because you cannot just add
> members in a one-to-one channel."

Done: `POST /api/channels/:id/members` and
`DELETE /api/channels/:id/members/:userId` now answer 403
`CHANNEL_DM_MEMBERS_FIXED` for `channel.type === 'dm'`.

Pending: hide the Members header action for DMs in
`admin/src/components/features/channels/ChannelHeader.tsx` (it is already hidden
for Personal Assistant conversations — same shape).

**Conflict to resolve with task 4.** The add-member path for a DM used to call
`createGroupFromDm`, which forked the pair into a new group channel. I removed
that call, but task 4 asks for exactly this capability behind an explicit
question ("new group, or add them here and show full history?"). So:
`createGroupFromDm` is deliberately left in place in
`api/src/services/channel-dms.ts` rather than deleted, and the flat 403 above is
expected to be **superseded** by task 4's explicit-mode API (e.g. a required
`mode: 'new_group' | 'add_here'`). The 403 is the correct behaviour for an
*implicit* add — "you cannot **just** add members" — and should stay until task
4 replaces it. Do not delete `createGroupFromDm` in the meantime.

Note: group DMs today are `type: 'standard'`, not `type: 'dm'`, so this 403 does
not touch them.

## 4 — Compose a new direct message (design)

> "if I click + on the direct messages, it takes me to 'Invite a user.' What it
> needs to take me to is a new message screen where I can set up who I am
> messaging in a top row, like 'Who am I sending an email to?' in an email
> window. I need to be able to add users and agents and just do this kind of
> group DM channel. If I add a user to this GroupDM, it needs to ask me if I
> want to create a new group or just add them to the existing one, in which case
> they're going to see the full history. This task is design, so consult with
> Kimix on how we're gonna implement this visually."

Design-first. Consult Kimix on the visual implementation. Must cover: the
recipient token row (users **and** agents), what happens with one recipient
(existing 1:1 DM) vs several (group), and the new-group-vs-add-here question
including the history-visibility consequence stated plainly to the person
choosing.

Brief: [2026-08-12-dm-compose-brief.md](2026-08-12-dm-compose-brief.md) —
Kimix consult running, output to `2026-08-12-dm-compose-proposal-kimix.md`.

Grounding facts: the `+` calls `onNavigateSettings('members')`
(`admin/src/layouts/admin-shell/SidebarDmSection.tsx:56`), which is the org
member-admin screen. Starting a DM is `POST /api/dm/:userId` — one user, no
multi-recipient path. A "group DM" is not a type: `createGroupFromDm` makes a
`type: 'standard'`, `visibility: 'private'` channel labelled with the
participants' display names — which task 2's slug rule now turns into
`alice-smith-bob-jones`, so the design has to say what a group DM is *called*.

## 5 — A dialog must not close on a drag that began inside it

> "If I'm in a pop-up window and I select a text to be renamed in a text field,
> but I lift my left mouse button outside of the pop-up, it dismisses the
> pop-up. It should only dismiss the pop-up when I tap outside fully."

Cause: every scrim in the admin was written as
`onClick={(e) => { if (e.target === e.currentTarget) close() }}`. The browser
dispatches `click` on the nearest common ancestor of press and release, so a
drag from inside the panel to the scrim targets the scrim and dismisses. 18
dialogs share the defect.

Fix: one shared `useOverlayDismiss`
(`admin/src/components/shared/useOverlayDismiss.ts`) that judges both ends of
the gesture — dismiss only when press **and** release both land on the scrim —
spread onto the overlay in place of the hand-rolled handler. Escape and the
panel's own close button are untouched (`useModalA11y`).

## 6 — Starred section: three defects

> "if I go to a one-to-one conversation or channel that is starred, like in my
> favourites, the star is not selected in the detail. It works for all channels,
> apart from when I'm talking to myself and I've put myself into the starred
> section, so everything else works. It is just myself. Also, I just started an
> agent, like a direct message to an agent, and in the Starred section it shows
> as a #Smith because I named the agent Smith. Personal Assistant is correct
> with an icon, but Smith is with a #. And also, there are two Smithies selected
> at the same time."

Screenshot supplied by the owner confirms all three. Three separate defects
sharing one surface (the starred-row builder in `admin/src/layouts/admin-shell/`):

- **6a — Self-DM star state.** A starred 1:1 with *yourself* does not show the
  header star as selected when opened. Every other channel and DM does. Suspect
  the favourite is keyed by user id for people, but the self-DM resolves to a
  channel whose identity does not match the key the header checks.
- **6b — Agent DM renders as a channel.** A starred agent DM shows as `# Smith`
  with the channel hash, while the Personal Assistant in the same list correctly
  shows its own icon. The Direct-messages section renders that same agent with
  its avatar, so the correct renderer exists and the starred list is forking it
  instead of reusing it (Rule zero #4).
- **6c — Two rows highlighted at once.** Opening the agent DM marks both the
  Starred `# Smith` row and the Direct-messages `Smith` row active. Active state
  is computed per-section against different identities (channel id vs agent/dm
  id) rather than once against the resolved active channel.


## 7 — Channel tabs: remove Runs, remove Info, composer only on Messages

> "when I click on a channel, there's a tab called 'Runs'. Not really sure what
> that is good for. Probably we should remove that. It even shows agents that
> are not even related to the channel or workspace, so just remove the page.
> Also, when I'm switching between the different tabs, only the messages should
> have the message text input at the bottom. The agents and info also seem
> duplicate, so just keep the agents, remove info."

Confirmed in the code:

- **Runs** (`ChannelTabPanels.tsx:144`) lists `scopedAgents` — agents scoped to
  the shell, *not* to this channel — under the heading "Active runs", beside
  three counters (Safe tools / Streaming messages / Bound agents) that drive no
  decision. Rule zero #3. Remove the tab and its panel.
- **Info** (`:122`) renders an `AgentInfoCard` per bound agent; **Agents**
  (`:219`) renders the same bound agents with more detail. Genuine duplicate —
  keep Agents.
- **Composer** renders unconditionally in `ChannelsPage.tsx:406`, outside the
  tab switch, so the message box sits under Files and Info too.

One thing Info does that Agents does not: it shows
`PersonalAssistantConfigBanner` for the PA conversation. Runs/Agents are hidden
on conversation surfaces (`!isConversationSurface`), so deleting Info would drop
the PA config banner with nothing to replace it. Decision: move the banner into
the Agents panel and show the Agents tab on a conversation surface **only when
it has something to say** — the PA banner, or at least one bound agent. A
person-to-person DM therefore shows Messages + Files only.


## 8 — Deep Water research launcher: presets, no title, real language selector

> "For the deep water deep research, we need to have two states: Light standard
> / Heavy / Custom. With custom, we literally just are going to have all the
> options that are in the pop-up now. With light standard and heavy, we can
> assume the settings. I don't think we need a title. It's like, 'What do you
> want to research?' There's one thing missing, and that's a nice custom
> dropdown selector, the same one that we've got in deep water. You can take a
> look at it in a parallel folder to this one called water. There's a dropdown
> that kind of allows you to select the search languages, so if you want to
> search stuff in all Western languages, most common languages, or just select
> them one by one, I want the same system in this dropdown. Obviously, you need
> to make sure that the MCP is available for the local agents. If they are
> personal agents as well, if they have access to the deep water research tool,
> then they need to be able to control all of this as well."

Screenshot of the current dialog supplied. Today `New Deep Water research`
(`admin/src/components/features/integrations/DeepWaterResearchLauncherDialog.tsx`)
shows, all at once: Research template, Title, Research prompt, a six-way Depth
grid (Light / Standard / Deep / Heavy / Thesis / Dissertation), then Chapter
detail, Output, Search quality, Recency, Sections, Searches per pillar, Output
language, Destination. Fourteen controls before the question is even asked.

Required:

1. **Three modes, not six depths + twelve knobs.** `Light` · `Standard` ·
   `Heavy` · `Custom`. (The owner said "two states" then listed four — read as
   three presets plus Custom.) Each preset assumes its settings; only Custom
   reveals the full control set that exists today, unchanged.
2. **Drop the Title field.** The prompt is the question — "What do you want to
   research?" is the whole ask.
3. **A real language selector**, replacing the single-value `Output language`
   dropdown. Multi-select with group shortcuts — "all Western languages", "most
   common languages", or pick individually. **Reference implementation exists**:
   the `water` repo, a sibling folder of this one. Read its dropdown and match
   the system, not just the look.
4. **Agents must be able to drive all of this too**, not just the dialog. Any
   agent granted the DeepWater tool — including a *personal* agent / PA — needs
   the same control surface through the MCP tool arguments. Verify the projected
   `research_start` schema actually carries these parameters; if the presets and
   the language set are UI-only, an agent can never reach them, and that is a
   Rule zero failure in the other direction (surface without capability).

Open questions to resolve before building: what exact settings each preset
assumes (must come from Ledger's real `research_start` contract, not invented);
whether `Research template` survives alongside the new mode selector or is
absorbed by it; and whether the language set is a Ledger-supported parameter at
all — check before designing a control for something the API cannot accept.


### Task 8 — verified findings and owner decisions (2026-08-12)

Phase-1 investigation, independently re-verified against both repos:

- **Ledger's MCP `research_start` is strict and minimal.** `mcpStartSchema =
  researchStartBaseSchema.omit({ callbackUrl: true, deepwater: true })`
  (`ledger/api/src/routes/research-mcp-server.ts:29`), so exactly
  `{ query, context?, depth: light|standard|deep|heavy, recency: any|recent }`,
  `.strict()`. The rich `deepwater.research-config.v1` envelope — which carries
  `languages: string[]` (83 codes), `output_language` (12 codes),
  `chapter_depth`, `output_tier`, `search_quality`, `searches_per_pillar`,
  `sections`, and a 5-way `recency` — exists **only** on Ledger's REST
  `POST /v1/research`, reserved for DeepWater's own product key.
- **Everything else in the dialog is already prose.** Chapter detail, output
  tier, output language, search quality, sections and searches-per-pillar are
  passed as text lines inside `context`
  (`api/src/routes/integrations/handoff-builders.ts:45-56`), which Ledger
  concatenates into the research question.
- **Thesis and Dissertation are not real tiers** — both map to `heavy`
  (`handoff-builders.ts:9-12`); Ledger disables them.
- **Output language offers 184 ISO codes; DeepWater supports 12.**
- **Recency offers day/week/month/year; all of it collapses to `recent`** and
  the chosen window never reaches the request.
- **Water's reference implementation**: `LanguageReachDropdown.tsx`
  (English only / Top 10 / Top 20 / Custom, active option *derived* from the
  selection rather than stored) over `LanguageSelect.tsx` (region-grouped
  multi-select, region-header click selects all, alt-click deselects, region
  chips, search, pinned `en`, empty = auto-detect), vocabulary in
  `water/packages/core/src/languages.ts`.

**Owner decisions:**

1. **Do not ship a prose-only language control.** "If we're running stuff
   through the Ledger, then we need to make sure that all the functionality is
   in the Ledger as well… bring everything to parity with what is in the deep
   water at the moment." → new task 9; task 8's language selector waits for it.
2. **Presets drop the fake tiers, Custom keeps everything.** "Removing the
   buttons only in the new screen. If you do custom, then we're gonna show the
   full stuff as it is now, with the added option of languages." So
   Light/Standard/Heavy are the preset modes; Custom renders today's complete
   control set unchanged, plus the language selector.
3. **Title is removed from the form entirely.** "The AI should just create its
   own title in deep water… we're just going to inherit one once the report is
   created." So Nessie stops asking, and takes the title from the report when
   it lands.

**Shipped (2026-08-12):** the mode selector (Light/Standard/Heavy/Custom, each
preset carrying a complete set of real contract values; the active mode derived
from the values, never stored), the question-first form, Custom rendering the
complete existing control set unchanged, `title` removed from
`DeepWaterResearchLaunchRequest` / the launcher / the run insert / the handoff
context lines, and the launcher's context-line vocabulary documented in the
projected `research_start` tool description so a granted agent (PA included)
composes the same instructions by hand. The language multi-select is not built
and `DeepWaterResearchCustomControls.tsx` is its landing site; the file's
docblock says so.

**Title inheritance is blocked, and not by choice of implementation.** Ledger
returns no title in any authenticated payload: the start ticket is
`{ id, job_id, status, eta_minutes, status_url, events_url, report_url }`,
`researchStatusDto` is `{ id, status, progress?, eta_minutes? }`, and
`researchReportDto` is
`{ report_markdown, references[], depth, started_at, completed_at, truncated }`
(`ledger/api/src/repositories/research-repository.ts`). `title` appears in
Ledger's contract only as an *input* field of the REST-only config envelope and
as a per-source reference title. The one title-shaped value available is the
report markdown's own H1 — but Nessie has no server-side path that ever sees a
completed report: the only server-side interception of `research_report` lives
in the launch-turn handoff guard (`worker/src/run/deepwater-handoff-guard.ts`,
which persists the source count), and a launch turn ends while the job is still
running for ~20 minutes. Reading the H1 would therefore need a new server-side
report-fetch path, and any such value would need the same trusted-provenance
discipline as `reportUrl`/`sourceCount` so an agent-authored
`deep_water_run_update` cannot forge it. Until then a card is named by its
query (`researchCardTitle`, matching the run history's existing
`title || queryPreview` fallback). Task 9's parity work should be asked to
return a report title as a typed field — that closes this properly.

## 9 — Ledger: MCP research_start parity with the DeepWater REST contract

Cross-repo task in `/Volumes/External/Projects/ledger` (parallel project, own
worktree under its `.worktrees/`).

Ledger deliberately omits `deepwater` from the MCP start schema, so every
MCP-based caller — which is all of Nessie — can only send depth and recency.
Nessie must therefore smuggle real research parameters through prose. The owner
wants that closed: the MCP adapter should reach parity with what DeepWater's own
REST launch can express, so `languages`, `output_language`, `chapter_depth`,
`output_tier`, `search_quality`, `searches_per_pillar`, `sections` and the full
recency window become typed parameters over MCP.

Open on the Ledger side before building: why the exclusion exists (billing
product binding? per-key entitlement? cost control?), and whether parity should
be universal or gated to entitled product keys. That reasoning is Ledger's, and
must be read before changing its contract — the docs state MCP starts are
excluded deliberately, so this is a contract decision, not an oversight to
patch.


## 9 — Ledger parity: shipped on a branch, NOT merged

`claude/deepwater-mcp-parity` @ `1f6d8f6`, pushed; local and remote SHAs verified
identical. 1067 tests / 140 files green, lint and typecheck clean.

The framing changed once the real gate was found: `assertDeepwaterApplicationLaunch`
(`ledger/api/src/services/research-start-provenance.ts:104`) rejects any caller
whose `applicationProduct !== "deepwater"` on **both** transports, so the MCP
`omit()` was cosmetic — Nessie would have been refused on REST too. It was a
product-identity gate, not a transport gate, born in the same commit as the
feature (`21e9d5a`) as a bridge for Water's own admin UI.

Shipped: one `researchOptionShape` spread into both the flat start contract and
Water's envelope so they cannot drift; Tier A **and** Tier B reachable flat with
no capability flag; `recency` widened as a strict superset (`any`/`recent`
byte-identical on the wire, four dated windows forward structurally); `thesis`
and `dissertation` as **real priced tiers** with catalogue rows, output-token
bounds and price-discovery entries, proven by an integration test booking a
`thesis` run at its own price rather than `heavy`'s; DeepWater's report title
persisted and surfaced on status, report and the job list.

Held closed deliberately: `visibility` (maps to Water's root `public` flag — a
paired Nessie run must not be publishable on Water's public site), plus
`application_navigation` and `project_id` as Water-local UI state. Flat options
and the versioned envelope are mutually exclusive, so Water's path is untouched.

**Outstanding before this is safe in production:**

- **Prices for the two new tiers are provisional** — `thesis` 25,
  `dissertation` 40, extrapolated from `heavy`'s curve because the live
  `price-refresh` needs credentials that were not available. Ledger's AGENTS.md
  makes that refresh the release gate. Customers would be billed these numbers.
  Confirm before production traffic buys either tier. Same caveat on their
  output-token bounds.
- **The injected `deepwater_research` tool was deliberately left narrow** — four
  original depths, no options — so a model cannot self-select `dissertation`
  mid-completion. Explicit constant (`injectedResearchDepths`), not drift.
  Widen only on a deliberate decision.
- **Per-job compute ceiling still does not exist** for any caller. A run with
  `searches_per_pillar: 20` and premium search books the same single
  `researches` unit as a default one. Everything is metered and attributed, so
  nothing is free or hidden — it is a spend-shape question. Standing
  recommendation as its own ticket, explicitly out of scope here.

## 10 — Nessie consumes the Ledger parity

Blocked until task 9 merges and deploys. Then, on the Nessie side:

- Delete the thesis/dissertation → `heavy` collapse
  (`api/src/routes/integrations/handoff-builders.ts:9-12`) — Ledger prices them
  for real now.
- Build the language multi-select into Custom, at the seam left in
  `DeepWaterResearchCustomControls.tsx`, modelled on water's
  `LanguageReachDropdown` + `LanguageSelect` (derived active option, region
  groups, pinned `en`, empty = auto-detect).
- Send the run-shaping options as **typed parameters** and stop writing them as
  prose lines into `context`.
- Forward the real recency window instead of collapsing to `recent`.
- Inherit the report title from Ledger's new typed field, with the same
  server-only provenance discipline as `reportUrl`/`sourceCount` so an
  agent-authored `deep_water_run_update` cannot forge it.
- Cut the output-language list from 184 codes to the 12 DeepWater supports.
