# Brief: "New message" compose flow for direct messages

You are asked for a **visual/UX design proposal**, not an implementation.

## The ask, in the owner's words

> "If I click + on the direct messages, it takes me to 'Invite a user.' What it
> needs to take me to is a new message screen where I can set up who I am
> messaging in a top row, like 'Who am I sending an email to?' in an email
> window. I need to be able to add users and agents and just do this kind of
> group DM channel. If I add a user to this GroupDM, it needs to ask me if I
> want to create a new group or just add them to the existing one, in which case
> they're going to see the full history. This task is design, so consult with
> Kimix on how we're gonna implement this visually."

## Verified current state (read from the code, 2026-08-12)

- The `+` next to "Direct messages" in the sidebar
  (`admin/src/layouts/admin-shell/SidebarDmSection.tsx:56-64`) calls
  `onNavigateSettings('members')` — it navigates to `/settings/members`, an
  org-member admin screen, labelled `Invite people` for owners and
  `Open workspace profile` for everyone else. There is no compose screen at all.
- Starting a DM today happens via `POST /api/dm/:userId`
  (`findOrCreateDmChannel`) — one user id, no multi-recipient path.
- **`Channel.type`** is `standard | dm`. A 1:1 DM is `type: 'dm'` with a unique
  `dmKey`. A *group* DM is not a distinct type: `createGroupFromDm`
  (`api/src/services/channel-dms.ts:158`) creates a `type: 'standard'`,
  `visibility: 'private'` channel whose label is the other participants' display
  names joined with ", ". So "group DM" is currently a private standard channel
  wearing a person-shaped name.
- Agent DMs exist too: `sidebarAgentDms` /
  `Channel.systemChannelType = 'external_agent'`, plus the system-managed
  Personal Assistant DM (`personal_assistant`), which is immutable — the API
  rejects membership changes on it with `CHANNEL_SYSTEM_MANAGED`.
- Adding a member to a 1:1 DM used to silently fork it into a group via
  `createGroupFromDm`. That implicit behaviour was **just removed**: both
  `POST /api/channels/:id/members` and `DELETE .../members/:userId` now answer
  403 `CHANNEL_DM_MEMBERS_FIXED` for `type: 'dm'`, and the Members control is
  hidden in the channel header for DMs. Your design is expected to **replace**
  that flat refusal with the explicit question the owner describes. The
  `createGroupFromDm` service function is deliberately still in the tree,
  unused, waiting for this design.
- **Channel names are now always slug-form** — lowercase, hyphen-separated, no
  special characters, enforced at one server chokepoint
  (`validateChannelLabel`, which returns `label === slug`). This directly
  affects you: a group DM named from display names would become
  `alice-smith-bob-jones`. Say what a group DM should be *called*, and whether
  it should carry a stored name at all or be rendered from its participants.
- Existing multi-select prior art to study and possibly reuse rather than fork:
  `admin/src/components/shared/ChannelMembersPopup.tsx` and its
  `channel-members/` row components (`AvailableUserRow`, `AvailableAgentRow`,
  `use-member-filters.ts`), and the message-composer mention autocomplete
  (`admin/src/pages/channels/useChannelMentions.tsx`,
  `channelMentionTargets.ts`).

## House rules your design must respect

From `AGENTS.md` "Rule zero" and `CLAUDE.md`:

1. A capability needs one owning surface **and** an in-context entry point where
   the person is standing when the question arises.
2. Scope lists by entitlement, never by ambient session context.
3. Every element must name the decision it drives; cut anything that doesn't.
4. Reuse the surface, never fork it — one component parameterised by scope.
5. All colour comes from CSS custom properties in `admin/src/styles.css`
   (`var(--tx)`, `var(--sep)`, `var(--accent)`…). No raw hex, no Tailwind named
   colours. Multiple themes must keep working.
6. Files cap at 500 lines; split on real responsibility seams.
7. No over-engineering. Simplest thing that satisfies the goal.

## What your proposal must answer

Be concrete: name screens, routes, components, copy, keyboard behaviour.

1. **The compose surface.** Is it a route (`/channels/new-message`?), a modal, or
   an inline "draft channel" that occupies the message pane until sent — the way
   an email compose window does? Pick one and defend it. The owner's reference
   is an email compose window: a To row at the top, focus lands there, and the
   message body is right below.
2. **The recipient row.** Token/chip input holding **both users and agents**.
   Specify: how typing filters, how users and agents are visually distinguished
   (they are different kinds of participant with different consequences), how
   tokens are removed, keyboard rules (Enter, Tab, comma, Backspace on empty),
   paste behaviour, and what happens when nothing matches.
3. **Resolution as recipients change.** One human recipient should land in the
   *existing* 1:1 DM if one exists (with its history) rather than making a
   second one. Two or more → a group. What does the UI show as this flips —
   does the header/body change to reveal the existing conversation's history
   before the person sends? Say exactly what is shown at 0, 1, and n recipients.
4. **Agents as recipients.** Can an agent be mixed with humans in one group? Can
   a group be agents only? What about the Personal Assistant, which is
   system-managed and immutable — is it selectable at all? Answer explicitly.
5. **The new-group-vs-add-here question.** This is the crux. When someone adds a
   person to an existing group DM, they must be asked whether to create a new
   group or add to this one — and told plainly that adding here exposes the
   **full prior history** to the new person. Design that dialog: exact copy, the
   default (if any), how the irreversibility is conveyed, and where the question
   is triggered from. Then say what the API needs (an explicit mode on the
   member-add call, so the server never guesses).
6. **What a group DM is called** — see the slug constraint above. Stored name,
   derived-from-participants name, or renameable? What appears in the sidebar
   for a 3-person group, and what happens to it when a 4th joins?
7. **Where group DMs live in the sidebar** — under Direct messages with the
   1:1s, or their own section? What does the row look like (avatars? count?).
8. **Empty and error states**, and what a person without permission to message
   someone sees.
9. **The minimum first slice** that still satisfies Rule zero.

Also list, briefly, the **server-side changes** your design implies — new
endpoints, an explicit `mode` parameter, a group-DM channel type or flag,
whatever it is — as a dependency list, not a spec.

## Format

Markdown. Lead with a one-paragraph summary of the model you chose, then the
numbered sections. Include ASCII wireframes of: the compose surface at zero
recipients, the same with three tokens (mixed user + agent), and the
new-group-vs-add-here dialog. Be decisive — where there is a fork, pick a branch
and say why the other loses. 1,500–2,500 words.
