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
