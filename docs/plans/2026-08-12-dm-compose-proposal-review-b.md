# Proposal: "New message" compose flow for direct messages

**Model chosen: one compose route, `/channels/new`, owning the whole flow; the
sidebar `+` points at it.** The skeleton already exists:
`admin/src/pages/ChannelConversationComposePage.tsx` is a To-row-plus-body
compose page at `/channels/new`, and `POST /api/channels/conversations`
(`findOrCreatePrivateConversationChannel`, `api/src/services/channel-dms.ts:314`)
already resolves the recipient set: self-only → self-DM, one human → existing
1:1 `dm` by unique `dmKey`, one agent → existing agent DM, anything bigger → a
new private group channel with `agentBindings`. What is missing is wiring (the
sidebar `+` still routes to `/settings/members`), the resolution preview as the
To row changes, and — the crux — the explicit *new group vs add here* question
when someone is added to a conversation that already has history. This proposal
fills exactly those gaps and leaves the rest of the architecture untouched.

## 1. The compose surface

**A route, `/channels/new`.** The inline "draft channel" loses because the
message pane's data (history, header, composer state) belongs to a concrete
channel id; rendering "no channel yet" inside `/channels/[id]` forks the whole
conversation surface into an empty-state twin — exactly what Rule zero forbids.
A modal loses because it covers the sidebar, the very list the person is
composing *against*, and caps a conversation that is about to grow. A full
route wins for three concrete reasons:

- **It already exists.** `ChannelConversationComposePage` renders a `To` row, a
  `MentionInput` body, and a send button; `useAdminShell.navigateToNewConversation`
  (`admin/src/layouts/admin-shell/useAdminShell.ts:262`) already navigates
  there. Zero new surface budget.
- **History continuity.** When the To row resolves to an existing 1:1 DM (§3),
  the page can render that conversation's history *in place* — a modal could
  not do this without covering the thing it previews.
- **One surface, deep-linkable.** `/channels/new` is the single home for "start
  a conversation". Doorways (Rule zero): the sidebar `+` beside "Direct
  messages" (re-pointed from `onNavigateSettings('members')` to
  `navigateToNewConversation()`, aria-label `New message`), and the channel
  header affordance that opens compose pre-seeded with the current participants
  for the add-here flow (§5).

Keyboard: focus lands in the To row on mount (`autoFocus` already there).
`Escape` navigates back. `Cmd/Ctrl+Enter` sends from anywhere in the page.

## 2. The recipient row

One token input holding **users and agents together**, exactly as the current
page does — keep it, and tighten four behaviours:

- **Typing filters** by case-insensitive substring across display name and
  email/role (the existing `matchesQuery`), users first, then agents, capped at
  8 rows. No fuzzy matching, no scoring — this is recipient selection, not
  intent detection.
- **Visual distinction.** User tokens render with the round `UserAvatar`; agent
  tokens render with the agent-gradient initial tile already used in the
  sidebar agent rows, plus a trailing `Agent` suffix in `text-[color:var(--tx3)]`
  inside the token. In the dropdown, each row shows avatar/gradient tile, name,
  a detail line (email for users, role for agents), and a right-aligned kind
  label. Agents get a different icon *and* a label because the consequence
  differs: adding an agent means it may respond in the conversation.
- **Removal and keyboard.** Each token has an `×` button; `Backspace` on an
  empty input removes the last token (implemented); `Enter`/`Tab` commits the
  highlighted option (implemented); **comma commits the highlighted option
  too** — add this, it is the email-client reflex the owner described.
  `Escape` clears the query first, then blurs.
- **Paste.** Pasting one or more email addresses commits each matching user as
  a token (split on comma/semicolon/whitespace). Anything that matches nobody
  is left as text, and if the query matches nothing the dropdown shows one
  line: `No people or agents match "…"`. There is no invite-by-email path
  here — inviting is the `/settings/members` surface's job, and the dropdown's
  no-match line links there for owners: `Invite people →`.

Eligible users are all org members (entitlement, never ambient session team).
Agents stay owner-only in the dropdown (`agents = isOwner ? allAgents : []`)
until the grant question in §4 is settled — current, deliberate behaviour.

## 3. Resolution as recipients change

The To row drives a **resolution banner** that sits between the To row and the
body and says what pressing send will do, before anything is sent:

- **0 recipients.** No banner. Body placeholder: `Choose people or agents
  above…`. Send disabled.
- **1 recipient, existing 1:1 DM.** Banner: `Continuing your conversation with
  Alice Smith` with a subtle `var(--tx3)` treatment. The body area below the
  banner renders the **existing channel's read-only history** (reuse the
  message list component, composer replaced by the compose body) so the person
  sees exactly what they are replying into. On send, the server resolves to
  the existing `dmKey` channel (already implemented) and the page navigates
  there; the sent message appears once, via the channel invalidation.
- **1 recipient, no history.** Banner: `New direct message with Alice Smith`.
- **n ≥ 2 recipients.** Banner: `New group with Alice Smith, Bob Jones and
  Review Agent` (names truncated with `+2 more` past three). Body stays the
  blank compose body — there is no history to show; if the exact recipient set
  already has a group channel, the server does not dedupe today (§6 names why)
  and the banner does not either.

So yes, the body changes — at exactly one human recipient the page stops being
a blank draft and reveals the conversation it will continue. That is the most
trust-building detail in the flow, and it costs only the lookup the client
already has (`sidebarPeople` maps users to their `dmChannelId`).

## 4. Agents as recipients

- **Mixed groups are allowed and already supported** — the server writes
  `agentBindings` on the group channel, so an agent can sit beside humans.
- **Agents-only groups** are permitted (the current user is always an implicit
  member, so a group is never truly humans-absent). One agent alone resolves to
  the existing agent DM.
- **Personal Assistant and product assistants (DeepSignal, DeepWater PA rows)
  are never selectable.** They are `systemManaged`/system-channel rows; the
  API rejects membership changes with `CHANNEL_SYSTEM_MANAGED`. The dropdown
  filters them out entirely rather than showing them disabled — an unselectable
  row invites the question "why not", and the answer is administrative, not
  conversational. This is a filter the *system* applies to its own managed
  surfaces, not entitlement-narrowing of people.
- Owner-only agent selection (§2) stays for this slice; the entitlement for a
  member to add an agent to a group is the agent-grant policy question, which
  is a separate dependency (§10) and must not be smuggled into this design.

## 5. The new-group-vs-add-here question

**Trigger point: inside the compose surface, at send time** — not a detached
dialog on the members popup. The flow: a person opens `/channels/new`
pre-seeded from the conversation they are standing in (a "New message with
these people" affordance in the channel header's members control — which
today is hidden for DMs and becomes visible again for exactly this), adds
Dana, and the resolution banner flips to n-recipients mode. Because the
original set has an existing channel with history, the send button's label
becomes `Send to…` and pressing it — or any attempt to send with the expanded
set — opens the dialog:

```
┌────────────────────────────────────────────────────────────┐
│  Add Dana White to this conversation?                       │
│                                                              │
│  Dana will see the full history of this conversation,        │
│  including everything said before they joined. This          │
│  cannot be undone.                                           │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ○ Start a new group (recommended)                    │   │
│  │   A fresh conversation with Alice, Bob, Dana and     │   │
│  │   Review Agent. No history is shared.                │   │
│  ├──────────────────────────────────────────────────────┤   │
│  │ ○ Add to this conversation                           │   │
│  │   Dana joins and can read all 214 past messages.     │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│                    [ Cancel ]   [ Continue ]                 │
└────────────────────────────────────────────────────────────┘
```

Decisions, explicitly:

- **Radio choice, safe branch pre-selected.** `Start a new group` is
  recommended because sharing history is the irreversible branch, and the
  destructive branch carries the plain-language warning *in the option body*,
  not a footnote. The message count (`214 past messages`) comes from the
  existing channel record — a real number beats the word "everything".
- **The dialog is modal, themed with existing tokens** (`var(--scrim-strong)`,
  `var(--main)`, `var(--sep)` — the same overlay idiom as
  `ChannelMembersPopup`). Focus traps in the dialog; `Escape` cancels;
  `Enter` confirms the selected radio.
- **API: the server never guesses.** `POST /api/channels/:id/members` gains an
  explicit `mode: 'add_here' | 'new_group'` (required for channels with
  existing membership; rejected with 400 if absent). `add_here` adds the member
  in place; `new_group` reuses `createGroupFromDm` — which is why it was left
  in the tree. Today's flat 403 `CHANNEL_DM_MEMBERS_FIXED` is replaced by 400
  `CHANNEL_DM_MODE_REQUIRED` carrying the hint that the client must ask. The
  existing message is then sent to whichever channel the mode resolves to.

## 6. What a group DM is called

**Derived from participants, never stored as a user-typed name, rendered — not
relied upon as storage.** The slug rule (`validateChannelLabel`: label ===
slug, lowercase-hyphenated) makes display names like `Alice Smith, Bob Jones`
impossible to store, and `alice-smith-bob-jones` as the *visible* name is
clearly wrong for a DM surface. So:

- The channel row keeps a slug (`alice-smith-bob-jones`, made unique by the
  existing `uniquePrivateChannelSlug`) as its storage/address identity — that
  constraint is satisfied unchanged.
- Everywhere a human reads the name — sidebar row, header, banner, dialog —
  the group renders **from its member list**: `Alice Smith, Bob Jones` for the
  current user (self excluded, matching how 1:1 DMs render as the *other*
  person's name), truncated to `Alice Smith, Bob Jones +2` past two names.
  Agents render by name in the same list.
- **Not renameable in this slice.** A rename affordance is a future decision;
  today the name answers one question ("who is in here?") and derived names
  answer it perfectly. When Dana joins, the sidebar row simply reads the new
  member list — no rename event, no stale name, nothing to maintain.
- Implication: group channels need members in their record payload (§10); the
  derived label is a pure client function `groupDmLabel(members, agents, me)`.

## 7. Where group DMs live in the sidebar

**Under Direct messages, with the 1:1s — not their own section.** The section
answers "who am I talking to privately?", and a group of three is the same kind
of answer as a pair; a separate heading would only compete with it. Ordering:
product assistants and agent DMs keep their current positions; 1:1 and group
rows interleave below, sorted by `lastMessageAt` (which `mapChannelRecord`
already emits) rather than the static `users` order — a group just created must
appear near the top, not below four people never messaged.

Group row: stacked double-avatar (two overlapping 18px circles, second offset
−6px, the standard idiom), derived label, unread count badge, no star affordance
in this slice. `useSidebarDms` gains a `sidebarGroups` derivation from
channels of the group kind (§10) whose membership includes `me`.

## 8. Empty and error states

- **Compose, zero recipients:** §3. **No-match query:** §2, with the owner-only
  `Invite people →` link to `/settings/members`.
- **A person you cannot message** (left the org, or server rejects):
  `POST /api/channels/conversations` already answers 403
  `INVALID_CONVERSATION_RECIPIENTS`; the compose page shows `One or more
  recipients are no longer available. Remove them to continue.` Tokens are not
  auto-removed — the sender decides.
- **Send failure** (network): existing error line, message text preserved in
  the composer (MentionInput is not cleared until success — current behaviour,
  keep).
- **Empty group sidebar section:** unchanged — the section always has the PA
  row and people rows; groups only add rows.
- **Non-owner opening a pre-seeded compose containing an agent:** the agent
  token renders read-only (no `×`) — they can talk in the group, not re-cast it.

## 9. The minimum first slice

Rule zero demands: one owning surface plus an in-context doorway, nothing
unreachable. The smallest coherent cut:

1. Re-point the sidebar `+` to `/channels/new` with label `New message`.
2. Resolution banner + 1:1 history preview (§3) — this is what makes the
   surface *about messaging* rather than about picking people.
3. The new-group-vs-add-here dialog with the explicit `mode` API (§5) — the
   owner's crux requirement, and it replaces a shipped 403 dead end, so it is
   not deferrable.
4. Derived group labels in header/banner (§6) and group rows in the DM
   sidebar section (§7) — without these the created group is invisible, which
   is exactly the failure Rule zero exists to prevent.

Explicitly deferred (and why it is safe): sidebar recency re-sort (groups
append after people rows initially), group rename, paste-to-token, member-side
agent grants. None of these leaves a capability unreachable.

## 10. Server-side dependencies (list, not spec)

1. `POST /api/channels/:id/members` — add required `mode: 'add_here' |
   'new_group'` for non-empty conversations; replace `CHANNEL_DM_MEMBERS_FIXED`
   with a 400 mode-required error; `new_group` path calls `createGroupFromDm`.
2. **Group identity flag.** Today a group DM is indistinguishable from any
   private standard channel (`type: 'standard'`). Add either a `ChannelType`
   enum value (`group_dm`) or a boolean/column flag set by
   `findOrCreatePrivateConversationChannel`/`createGroupFromDm`, so the sidebar
   can list groups and the UI can render derived labels without heuristics on
   `visibility === 'private'`.
3. **Members in channel payloads** (or a `GET /api/channels/:id/members` the
   client already effectively has via `ChannelMembersPopup` data) so the
   derived-label function has names without N lookups.
4. **Conversation resolution endpoint or response hint** — `POST
   /api/channels/conversations` already resolves, but the §3 preview needs to
   *know* the resolved channel id before send: either a lightweight
   `POST /api/channels/conversations/resolve` (same body, returns the existing
   channel or null) or client-side use of the existing `users[].channelIds`
   mapping for the 1:1 case only. Prefer the client-side mapping for the
   slice; groups have no dedupe to preview.
5. Agent-grant entitlement for non-owners in mixed groups — separate decision;
   the UI stays owner-gated until it lands.
6. No change to `dmKey`, 1:1 DM semantics, or PA immutability. The mode
   parameter and group flag are documented in the implementation turn.

## Wireframes

**Compose, zero recipients:**

```
┌────────────────────────────────────────────────────────────────────┐
│ New chat                                                             │
├────────────────────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ To  [ Add people or agents___________________________ ]        │ │
│ │     ┌────────────────────────────────────────────────────────┐ │ │
│ │     │ ○ Alice Smith        alice@acme.com              user  │ │ │
│ │     │ ○ Bob Jones          bob@acme.com                user  │ │ │
│ │     │ ◆ Review Agent       code review                agent  │ │ │
│ │     └────────────────────────────────────────────────────────┘ │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ Choose people or agents above to start a conversation          │ │
│ │                                                                │ │
│ │                                                                │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │                                                        [ ➤ ]   │ │
│ └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

**Compose, three tokens (mixed), resolution banner visible:**

```
┌────────────────────────────────────────────────────────────────────┐
│ New chat                                                             │
├────────────────────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ To  [◯ Alice Smith ×] [◯ Bob Jones ×] [◆ Review Agent ·Agent ×]│ │
│ │     [ ____________ ]                                           │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ ⓘ New group with Alice Smith, Bob Jones and Review Agent       │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │ Message                                                        │ │
│ │                                                                │ │
│ ├────────────────────────────────────────────────────────────────┤ │
│ │                                                        [ ➤ ]   │ │
│ └────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

**New-group-vs-add-here dialog:** see §5.
