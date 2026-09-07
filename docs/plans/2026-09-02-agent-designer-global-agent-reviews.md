# Agent Designer and global agents — review appendix

This appendix keeps the review record, open question, and adjacent defects for
[the Agent Designer and global agents plan](2026-09-02-agent-designer-global-agent.md).

## Cross-model review (2026-09-02)

Kimix (14 findings) and Codex Sol (22 findings) reviewed the same revision
independently; both verdicts were "not implementation-ready", and every adopted
claim was re-verified against code before the revision that answered it. Each
finding below is now built, and the design decision it changed is stated in the
D-section that owns it — this is the record of *why* those sections say what
they say.

**Converged:** D3's plumbing was under-specified (surface facts never reached
`authorizeToolCall`, and the toolset must omit rather than offer-then-deny);
the sidebar/admin work was understated (`useSidebarDms`, the DM predicates and
participants, not just the identity directory); `agent_read` cited a
nonexistent route and contradicted the read-only detail view (resolved as the
config-only projection); edit authority needed field-sensitive enforcement,
because the PUT body carries `ownerUserId` and `todosEnabled`; the handoff
needed a real loop bound (a per-requester cooldown row, withheld from global
agents and subtask children).

**Kimix:** the channel-surface CHECK violation twin; the five `agentKind`-keyed
delegation sites re-keyed onto one predicate; delegated reads feeding the
disclosure sink; the handoff-basis subtraction, without which the Designer is
silenced in its own DM; the `systemSlug` CHECK requiring `organizationId`; the
api face's missing registry access (D5, delivered in phase 4).

**Sol:** unattended trigger runs would have wielded identity tools (hence the
interactive arm and no self-triggers); nothing prevented a second agent binding
into a system DM, nor rename/archive of one; `wait: true` holds the thread
slot, so "answer in chat instead" required the no-wait default;
`updateAgentRecord` did not refuse existing system rows; "promote is the
existing publish act" was false, visibility being immutable; a PA-presence
handoff would have opened the PA *owner's* DM rather than the asker's; the
handoff bypassed `claimThreadRunOrPend` and impersonated the requester with an
editable `role:'user'` message; the origin "link card" could not be expressed by
the card contract; `agent_create` never generated avatars; the general
`agent_update` conflicted with conversational-setup (explicit supersession); and
the blueprint had no model fields.

**Noted, not blocking:** message edit does not refuse
`agentCardResponse`-stamped rows (filed as an adjacent defect below).

## Open question

Two of the original three are answered by the build: `gagent:` DM keys stay
org-scoped with no UOA team segment (creation acts org-wide), and bootstrap runs
at **login**, beside the Personal Assistant's, so the sidebar DM row is simply
there. The one still open is whether entitled members may *claim* a team-owned
agent — v1 says no (org owners only): an edit helps everyone, a claim locks
everyone else out. Revisit if release/claim churn shows up in real use. Two
earlier questions were resolved in the design itself: the `PUT /api/agents/:id`
owner arm became the "Edit authority" model, and model resolution is D1/D9's
blueprint pin → `NESSIE_DESIGNER_MODEL` → organisation default.

## Adjacent defects noticed while mapping

**Fixed along the way:** `createExternalAgentData` wrote a tuple
`agents_system_managed_invariants_chk` forbade and a DM key
`channels_personal_assistant_surface_chk` rejected — both repaired by migration
`20260902170000_external_agent_surface_invariants`, with
`api/test/external-agent-bootstrap-db.test.ts` now driving the real service
against Postgres, because the cast fake could see neither CHECK. That is the
`extagent:` lesson D2 cites. Also: `POST /api/designer/chat` dropped
`pageContext` before the prompt; `PA_PRESENCE_PRIVATE_READ_TOOL_IDS` carried a
dead `message_post` entry (removed, with a test asserting every id resolves);
`CreateAgentBodySchema` accepted a `routingProfileId` the route discarded
(removed rather than wired — it is server/bootstrap-only).

**Still open:**

- The `pa:%` arm of `channels_personal_assistant_surface_chk` carries no
  `system_channel_type` condition (it predates the type-keyed arms), so a row
  claiming `system_channel_type = 'system_agent'` with a `pa:` key is still
  admitted. Nothing can reach that shape today — bootstrap only writes
  `gagent:` keys and `assertGlobalAgentRunPlacement` requires that prefix — and
  tightening the legacy arm wants its own migration plus a survey of existing
  rows.
- `updateMessage` (`api/src/services/messages.ts`) does not refuse editing a
  message stamped `agentCardResponse`, though the cards spec says a card
  response is immutable — a resolved card's decision text can be edited into
  disagreement with the card's authoritative state.
