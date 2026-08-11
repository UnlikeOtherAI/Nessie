# Viewer-scoped agent knowledge — disclosure basis and the nod

**Status:** designed, reviewed by two independent models, not yet implemented.
**Date:** 2026-08-11
**Owner:** Ondrej Rafaj
**Companion:** [2026-08-11-inter-agent-communication.md](2026-08-11-inter-agent-communication.md)

---

## The requirement

> Every token an agent emits must be derivable from
> **`agent_reach ∩ asking_viewer_entitlements`**, plus anything explicitly
> disclosed to that viewer by an entitled human. Enforcement is at the data
> layer. The prompt is never the control.

In the owner's framing: a shared agent invited into a team must not carry
privileged knowledge from elsewhere into that team's conversations. If an
entitled person asks a privileged question in front of others, the agent may
answer — that person is making a disclosure decision. But the *next* person's
question is evaluated against *their* entitlement, not against what is now
sitting in the thread. Extending that disclosure requires an explicit nod.

Two consequences the design must honour:

1. **Disclosure does not transfer.** Being able to read a message with your eyes
   is not the same as an agent re-reading, summarising, or answering from it on
   your behalf. The line held is **amplification**.
2. **The nod is a mechanism, not etiquette.** An auditable, revocable act by an
   entitled human — never the agent, never a peer agent.

---

## What already works

Verified in the tree, 2026-08-11:

- **`resolveAccessibleScopes`** (`packages/memory/src/scopes.ts`) is already the
  single access boundary for curated memory and conversation search. Mode
  `user_shared` (`scopes.ts:263`) **intersects the agent's reach with the asking
  user's membership**, from membership tables only. Mode selection:
  `worker/src/run/execute/memory.ts:117-131`.
- **KB retrieval is already viewer-scoped.** `buildSpaceViewerPrincipal`
  (`worker/src/run/pa-tools/access.ts:57-64`) reads as the effective user when
  there is one, falling back to the agent only for autonomous runs — the same
  three-mode pattern, shared by every `kb_*` builtin so they cannot drift.
- **`KnowledgePageChunk`** mirrors scoping columns (`schema.prisma:3188`)
  specifically so retrieval filters inside the candidate query rather than after
  ranking.

Retrieval, in other words, is largely solved and solved correctly.

## The leak

**The transcript is not viewer-scoped.** `loadConversation`
(`worker/src/run/execute/prompt.ts:190-200`) filters on `threadId` and
`role != 'system'`. No viewer, no entitlement.

Minimal reproduction: channel C contains A (also in private project P) and B (not).
A asks about P → run r1 resolves `user_shared`, legitimately recalls P-scoped
memory, writes reply m1 into C's thread. B posts → run r2: memory recall
correctly excludes P, **but `loadConversation` returns m1 verbatim on `threadId`
alone**, so the model holds P-derived text and can restate it to B.

Three further paths replay the same content:

| Path | Where | Note |
|---|---|---|
| Engagement decision | `worker/src/run/orchestrate.ts:173-178` | Loads last 6 messages on `threadId` alone — privileged content reaches a model call *before* the run starts |
| Run checkpoints | `worker/src/run/execute/checkpoint.ts:51-66` | **Any** follow-up run in the thread claims the newest unconsumed checkpoint — and checkpoints persist a work-state note *plus verbatim sources* |
| Context compaction | `worker/src/run/context-compaction.ts:112-140` | Folds elder transcript into a note preserving findings and verbatim URLs. In-run only — but it reaches durable storage through the checkpoint above |

`promptOverride` (`worker/src/run/execute/run-job.ts:108`) is a fourth path into
the model that bypasses the window entirely; it is the asker's own turn, so it
is not itself a leak, but basis must chain through its writers (mailbox,
subtask, continuation).

---

## Design: disclosure basis

**Provenance, recorded at write time, evaluated at read time.**

At completion the worker already holds, structurally, what the run consumed:
injected memories with their `audienceType`/`audienceId`
(`worker/src/run/execute/run-setup.ts:127-131`), KB pages read, search channels.
No new instrumentation of the model is required, and nothing is model-reported.

- **Basis** = the scoped sources consumed that are **not already implied by the
  destination channel's own scope chain**. Empty in the common case ⇒ the message
  is unrestricted and costs nothing.
- **Stored** as `MessageBasisScope { messageId, scopeType, scopeId }` rows,
  written **in the same transaction as the message create**
  (`worker/src/run/execute/completion.ts:67`, which is currently a bare `create`
  and must become a transaction). A basis-computation failure fails the run, so
  nothing posts unstamped. Fails closed.
- **Read predicate**, applied at the window, the orchestrator's context load,
  conversation search, and the checkpoint claim: agent-authored messages
  anti-join `MessageBasisScope`; zero rows pass untouched. Restricted ones pass
  only if the viewer has membership in **every** basis row, or a live grant
  covers them.
- **Withheld turns render a server-authored placeholder**, never a silent
  omission — otherwise the model invents continuity across a gap it cannot see.
  Their images and attachment notes are skipped with them.
- **Mixed replies:** the message is the atom. A reply drawing on public and
  private sources is governed by the union of restrictions. Token-level redaction
  is not attempted.
- **Evaluated at read time** because membership and grants change. Revocation
  then needs no propagation — the next load simply excludes.

**Checkpoint basis must be the union of the compacted window, not merely what the
run retrieved.** A checkpoint inherits privileged content from the transcript via
compaction; stamping it by retrieval alone would miss that and ship a hole.

### Rejected alternatives

- **Whole-run scope tuple + intersection predicate.** Stamp each reply with the
  entire `AccessibleScopes` tuple the run executed under, and admit a viewer whose
  scopes intersect it. **This does not work:** `assembleScopes:202-205` puts the
  `organization` audience in the tuple for every org member, so the intersection
  is always non-empty and the predicate admits everyone. Too broad in what it
  records, too permissive in how it evaluates.
- **Model-judged sensitivity classification.** The judgement would *be* the
  control — precisely the "prompt is never the control" failure. Sensitivity may
  inform UI copy; never a predicate.
- **Coarse "this turn is restricted to audience X" marker.** Still needs the
  underlying scopes to evaluate, and over-restricts turns that consumed nothing
  privileged.

---

## Design: the nod

`DisclosureGrant { id, organizationId, messageId, grantedByUserId, audienceKind:
user | channel, audienceId, expiresAt?, revokedAt? }`, with an `AuditLog` row on
create and revoke.

- **Who may grant:** a human session only — agents cannot reach the endpoint —
  whose user **currently passes the message's full basis predicate**. Entitlement
  is checked against live membership, not authorship.
- **Scope:** one message by default; "share the thread" is a bulk call over the
  root's restricted replies. Audience is named users or the channel; a channel
  grant follows live membership.
- **Revocation:** `revokedAt`; read-time evaluation makes the next load exclude
  it everywhere. Content already inside a live run's window cannot be clawed back
  mid-run — stated honestly. That run's own reply carries its own stamp, so
  restriction re-attaches to derivatives.
- **Natural-language nod** ("you can tell the team"): the model **recognises**
  the intent — recognition is model-judged, never string-matched, per
  `AGENTS.md` — and surfaces a prefilled confirmation card to the entitled human.
  Only the human's click writes the row. **Recognition proposes; the audited
  structural record disposes.** This separation is what makes the nod
  injection-proof and revocable.
- **Surface (Rule zero):** the message owns it. A "Restricted sources" chip on
  stamped agent replies — the channel feed and thread panel share the one message
  component — opening a popover listing basis scopes and grants, with
  grant/revoke. For a non-entitled member the withheld placeholder is the
  in-context doorway: *"reply withheld — ask &lt;asker&gt; to share"*.

---

## Multi-viewer channels

**The asker's entitlement governs the reply.** Asking in front of the room is the
asker's own disclosure — identical in kind to pasting the answer themselves,
which no system can prevent. Intersection-over-all-readers was rejected: it lets
any single member silently lobotomise the agent for everyone, and is unstable
under channel churn.

What is actually held is **amplification**: humans may read the reply with their
eyes, but no later *run* re-reads, summarises, or answers on that basis for a
non-entitled asker without a nod.

**Open (owner's call):** whether a passive pre-send hint appears in the composer
("this may answer using Project P access; two people here cannot see it"). One
reviewer wants it for informed disclosure; the other rejected any pre-send gate
as contrary to "I can ask in front of others and it replies". Recommendation: a
non-blocking hint, never a gate.

---

## Phased plan

**Phase 1 — close the leak.** `MessageBasisScope` migration; basis capture in the
completion transaction; the predicate applied at `loadConversation`, the
orchestrator's 6-message context, and the checkpoint claim; checkpoint basis as
the union of the compacted window; withheld placeholder. Surface: read-only
"Restricted sources" chip. **This is the phase that closes the actual leak.**

**Phase 2 — the nod.** `DisclosureGrant` migration; grant/revoke API + audit; chip
popover UI; "ask &lt;asker&gt; to share" affordance; predicate honours grants;
NL-nod confirmation card.

**Phase 3 — secondary readers.** Predicate in conversation search and
`agent_messages`; basis chaining through the `promptOverride` writers (mailbox
send and subtask spawn carry the parent basis; child replies union it); standalone
`attachment_read` entitlement check; autonomous rule — no viewer means restricted
turns are visible only under a channel-audience grant. Non-English and slang
fixtures for nod recognition.

## What is deliberately not built

Token-level redaction; model-judged sensitivity as enforcement; filtering
human-authored messages (humans disclose deliberately — channel visibility already
governs); basis backfill over history (provenance is unrecoverable, so legacy
messages stay readable and the rule applies forward only); standing "share
everything forever" grants; retro-redaction of already-emitted replies.

---

## Open questions for the owner

1. A shared agent answering from the asker's **user-private** memory
   (`scopes.ts:206-209`) would stamp the reply `user:<asker>`, restricting that
   turn to them alone in future windows. Intended, or too aggressive?
2. Autonomous and scheduled runs recall org-wide (`scopes.ts:251-260`,
   `includeOrg: true`), so their replies in mixed channels would routinely stamp
   restricted. Narrow autonomous recall too, or accept the noise?
3. KB basis granularity — per page or per space? Per-space is the safe floor.
4. A checkpoint repeatedly skipped by non-entitled follow-ups stalls continuation
   until the entitled user returns. Acceptable?
5. Should a channel-scoped nod cover people who join the channel later?
6. Pre-send composer hint: yes (non-blocking) or no?

---

---

# Part 2 — Memory tiers and the consent card

Added 2026-08-11 after a second design round. Extends, does not replace, the
basis/nod design above.

## "Privileged" is a relation, not a tier

The requirement was framed as needing *different types of memory* — privileged,
channel-level, organization-wide. The taxonomy already exists and is finer than
that: `ThoughtAudienceType` (`api/prisma/schema.prisma:427-433`) is
`user | channel | team | project | organization`, mapped 1:1 to visibility at
`packages/memory/src/capture.ts:81-87`. The three requested bands are these five,
coarsened.

But the important correction is that **privilege is not an intrinsic property of a
memory.** It is a *relation between a memory's audience and the surface it is
about to enter*. Organization-tier material is privileged nowhere; project-P
material is privileged in a channel outside P's chain and ordinary inside it.
Storing a "privileged" label would duplicate `audienceType` and go stale the
moment the destination changes. **Do not add a parallel taxonomy.**

## The second axis: `SensitivityTier` — a live reader with no writer

`SensitivityTier` (`schema.prisma:435-439`) exists on `Thought` (`:2983`),
`KnowledgeSpace` (`:3039`), `KnowledgePage` (`:3110`) and `KnowledgePageChunk`
(`:3198`), all defaulting to `normal`.

Verified state:

- **Read-enforced for the KB, absolutely.** `packages/knowledge/src/access.ts:89`
  — *"Restricted content is humans-only: this wins over every other agent arm,
  including the agent's own private space or explicit membership."* Also enforced
  at `worker/src/run/pa-tools/knowledge.ts:145` and `knowledge-write.ts:91`.
- **Never filtered for memories.** `packages/retrieval/src/thoughts.ts:29` selects
  the column and no code filters on it.
- **Never written above `normal` in production.** The only assignment paths are
  optional caller pass-throughs (`api/src/routes/thoughts.ts:92`, the KB
  contracts), no admin UI control exists, and only test fixtures pass elevated
  values. (Note the near-name collision: `privacyTier: 'sensitive'` on integration
  plugin manifests is an unrelated field.)

**Verdict: keep it as a human-assigned second axis with a narrow job.** Audience
says *who*; sensitivity says *whether consent can lift at all*.

- `restricted` — never leaves its scope; no card is offered. Already the KB
  semantic; extend it to thoughts.
- `sensitive` — the card fires, but **the Allow-always button is withheld**.
- Assigned only by the author or a scope owner through a shipped UI control
  (currently missing). The model may *suggest* marking something sensitive; only
  a human click writes it.

The hard predicate stays audience-versus-audience, which is structural. A
human-assigned label may remove an option from a card; it never becomes the
enforcement.

## The firing rule

> The card renders iff **`basis(reply) ⊄ scopeChain(destination)`**, and some
> uncovered basis row has no live grant for that destination.

Never fires: organization-tier material anywhere in the org; project-P material
inside a P channel; a PA DM using its owner's own material (the PA acts as its
owner, `worker/src/run/execute/memory.ts:117-121`, and the DM's audience is
exactly that owner). Fires: P material entering a channel outside P's chain.

The shared-agent-1:1 case needs no special rule — user B's run resolves
`user_shared` and never retrieves A's project scopes in the first place; transcript
replays are withheld by the Part 1 read predicate.

**Computed from the destination's scope chain, not by enumerating members.** A
member-set comparison (*"does everyone here have access to P?"*) races membership
changes and, worse, is wrong for a durable artifact: a channel whose members all
happen to hold P access today may admit someone tomorrow, and the message
persists. Chains are stable; membership churns.

> **Spec bug caught in review:** one design expressed this as
> `P_members − C_members ≠ ∅`. That is the reverse subtraction — it fires when
> someone entitled is *absent from the room*, and stays silent when an
> unentitled person is *present*, which is exactly the leak. Had the predicate
> been implemented from that formula it would have inverted the entire control.
> The member-set form, if ever used, is `C_members − P_members ≠ ∅`.

## Where the gate sits: emission, with nothing held

**The reply posts immediately, restricted.** Basis stamps are written in the
completion transaction; non-entitled viewers see the withheld placeholder from
Part 1. The card is the affordance to **lift** that restriction, attached to the
posted message.

- **Deny is the default state, not an action that must win a race.** An
  unanswered card leaves the reply restricted forever. Nothing fails open.
- **Allow once** = the message-scoped `DisclosureGrant` from Part 1.
- **Allow always** = a standing scope-pair grant (below) plus the message grant.

**Rejected: gating at retrieval.** It asks the user to approve material the model
may never use, which trains click-through and destroys the control — and it
penalises the *entitled* asker, who would receive a degraded answer first and a
re-run after consent. That contradicts the settled position that the asker's
entitlement governs their own reply.

**Rejected: a held or suspended reply.** The machinery exists
(`RunStatus.waiting_approval`, `schema.prisma:66`; `ApprovalRequest.continuationToken`,
`:2617-2637`) but holding the entitled asker's own answer hostage to a card is the
same contradiction.

**On "the model has already seen it":** safe, because every downstream reader is
gated by Part 1 — subsequent windows, the orchestrator's 6-message load
(`worker/src/run/orchestrate.ts:173-178`), and checkpoints carrying the union
basis of the compacted window. No new mechanism. This is why **Part 1 must ship
before any of Part 2**: an emission gate without the read predicate would leak
through exactly the paths Part 1 closes.

## The card

Rendered on the restricted reply — the "Restricted sources" chip made actionable.
It never shows privileged content beyond what the viewer already sees. Using
placeholder names (`Meridian` a project, `#launch` a channel, `Scout` an agent):

> **This reply uses Project Meridian material.** 3 of 5 people in #launch can't see it.
> **Keep restricted** · **Share this reply** · **Allow Scout to use Meridian here ▾**

It names the source scope, the destination, the agent, and the concrete effect —
"this reply" versus a standing rule. Counts, never member lists: a list leaks the
membership gap itself.

### The third button is a duration menu, not a switch

The standing option is a **dropdown**, so choosing *how long* is the same gesture
as choosing *to allow*. Owner's decision, 2026-08-11: a blanket grant should be
bounded by time, on the reasoning that a grant is only really intended to last
while the granting human is around.

```
Allow Scout to use Meridian here  ▾
  ├─ for 10 minutes
  ├─ for the rest of today        (granter's local end-of-day)
  ├─ for 30 days
  └─ until I revoke it
```

**The available durations are capped by the source's tier** — the same rule that
governs whether a standing option appears at all, generalised from a binary to a
ceiling:

| Source | Ceiling |
|---|---|
| `organization`, `team`, `project`, `channel` audience, `normal` sensitivity | full menu, including *until revoked* |
| `sensitive` sensitivity (any audience) | short durations only — no *30 days*, no *until revoked* |
| `user` audience, or `restricted` sensitivity | **no menu at all** — Deny / Allow-once only |

Rationale: duration does not change the *kind* of consent — a 10-minute grant
still covers future, unseen replies — so the wiretap argument against standing
grants over private material holds at every duration. But it does change the
*blast radius*, so material that merely warrants care can have a short leash
rather than none.

**Defaults matter more than options here.** The menu's default selection is a
bounded duration, never *until revoked*; the unbounded choice stays available but
is not the path of least resistance.

**Presence-bound grants ("only while I'm here") are deliberately not built.**
Time is the enforceable proxy for presence. Tying a grant to a live session means
it dies when a laptop sleeps or a network blips — mid-run, unpredictably — and it
invites the question of what happens to a reply composed one second before the
granter's connection dropped. A stated duration is legible to the granter, stable
under flaky connectivity, and trivially auditable. `expiresAt` already carries it.

Renewal is always a fresh entitled click, never a timestamp bump: re-granting is a
new decision, and it re-runs the live membership check.

**Who may answer:** a human session currently passing the full basis predicate,
checked against live membership at click time rather than card-render time. Never
an agent, never a peer agent — no agent-reachable endpoint exists. **If nobody
present is entitled:** the reply stays restricted, entitled scope members receive
a `UserAlert`, and the placeholder tells others whom to ask. No timeout ever
auto-allows.

## Standing grants — the "allow always" bound

```
ScopeDisclosureGrant {
  organizationId,
  sourceScopeType, sourceScopeId,   -- the "from that one workspace" bound
  destinationChannelId,             -- one channel; never a thread, never a user
  agentId,                          -- this agent only
  grantedByUserId,                  -- audit + live entitlement recheck
  expiresAt, revokedAt
}
unique (sourceScope, destination, agent)
```

Each dimension, argued:

- **Source scope** — one `(type, id)`. P→C says nothing whatsoever about Q→C.
- **Destination = one channel.** Threads inherit channel visibility, so
  thread-level grants fragment into hundreds of unreviewable rows. Named-user
  destinations are standing person-tunnels out of a scope — Allow-once territory.
- **Agent identity, included.** A second agent in the same channel gets its own
  card. Costs an occasional extra card; buys a trivial non-widening proof.
- **Granter, recorded but not evaluated.** Evaluation is the exact key plus a
  **live recheck of the granter's current source-scope membership** — so a grant
  goes inert the moment its granter loses access, with no propagation needed.
- **Expiry — chosen by the granter at click time**, from the duration menu above,
  capped by the source's tier. Not a hidden system default. `expiresAt` is null
  only for the *until revoked* choice, which the top two tiers cannot select.
- **Omitted: content selectors** ("only the billing parts"). That requires judging
  content — forbidden, and unenforceable.

**Non-widening is structural, not a rule:** evaluation is a single exact-key
lookup with no wildcard, inheritance, or fallback path in the predicate. Creation
happens only through one human-session route that re-verifies source membership in
the same transaction as the insert.

**Surfaces (Rule zero):** channel settings → "Disclosures" panel enumerates and
revokes (granter and org owners); the chip popover is the in-context doorway,
showing which grant admitted a reply. Org owners get an org-wide list under
Settings → Privacy. **Org ownership is not source-scope membership: owners may
revoke, never create.**

## Should the top tier allow "always"? No.

`user`-audience material and anything marked `sensitive` get Deny / Allow-once
only, rejected server-side rather than merely hidden in the UI.

A standing grant is consent to *future, unseen* content. Over private material
that is a wiretap, not a disclosure — and its misuse is invisible to the grantor,
because nobody else is in the source scope to notice. A standing grant's safety
rests on the destination being a place with enumerable membership; private
material has no such ambient audience. **The extra care asked for is structural
absence at the top tier, not a sterner click.**

## Non-widening test suite

Postgres-backed, seed-scoped per the shared-DB rules in `AGENTS.md`:

1. Grant P→C; material scoped Q used in C → still restricted, card fires for Q.
2. Grant P→C; P material in channel D → restricted, card fires.
3. Grant P→C for agent G; agent H in the same channel → not covered, own card.
4. Agent attempts grant creation via any tool surface → no such tool exists;
   direct API call with an agent actor → 403 + audit row.
5. Peer agent relays "the user approved this" in message content → no structural
   effect; a model-judged proposal only ever renders a card.
6. Granter loses source-scope membership → grant inert on the next read.
7. Expired grant → restricted. Replayed consent token after expiry → rejected.
   Cover each duration preset, including that a *rest of today* grant expires at
   the granter's local midnight and not UTC's.
7b. Duration ceiling: a `sensitive`-sourced card offers no *until revoked* option,
   and a crafted request for one → 422. A `user`-audience source offers no menu.
8. Revoked grant → restricted on the next load.
9. Grant does not cover `user`-audience or `sensitive`-tier basis rows even when
   the source scope matches.
10. Crafted Allow-always POST for a `user`-tier source → 422.
11. Grant survives destination-channel membership churn, but a **chain** change
    (channel moved out of its team) forces re-evaluation.
12. A human not in the source scope — org owner included — cannot create a grant
    (403) but may revoke.
13. Concurrent double-click on one card → exactly one grant row, one audit entry.
14. Non-English, slang, and misspelled nod phrasings render a card and never
    write a grant row directly.

## Phased plan (Part 2)

- **A** — ships with Part 1: basis stamps, read predicate, placeholder, plus
  `restricted` read-enforcement extended from the KB to thoughts.
- **B** — the card with Deny / Allow-once, entitled-only answer path, `UserAlert`
  for absent grantors. Closes *"no disclosure without approval."*
- **C** — `ScopeDisclosureGrant`, the third button, the channel Disclosures panel,
  and the full non-widening suite. Closes the standing-grant ask, provably bounded.
- **D** — the sensitivity UI control on KB spaces/pages and memory capture, plus
  the model-suggests-a-mark card. Last, because it refines the card and never
  carries enforcement alone.

## Not built (Part 2)

A third taxonomy; model-assigned sensitivity as enforcement; held or suspended
replies; retrieval-time consent; standing grants to named users, threads, or "all
my scopes"; grant inheritance across agents; content-selective grants; retroactive
tier backfill.

## Decisions taken (Part 2)

**A grant widens visibility within its destination, and is time-bounded**
(owner, 2026-08-11). A grant admits *any* material from the granted source scope
into the granted channel, for everyone currently in that channel, for the chosen
duration. The granter's reasoning: if they hold the permission themselves, they
are content to allow anything from that scope into that place — but only while
they are effectively around, which the duration menu expresses.

Note what this does and does not widen. Within the destination channel, members
may receive answers drawing on the source. It grants **nothing** outside that
channel: a member who could not otherwise reach the source still cannot use it
elsewhere, because grant evaluation is keyed to the destination.

**Sensitivity stays KB-only** (inferred from the owner's stated requirement,
confirmed as a recommendation). Every tier described — 1:1, channel, project,
organization — is an *audience* distinction, and audiences already exist for
memories. No second axis was asked for. Practically, KB pages are deliberately
authored and can be deliberately marked; memories are auto-captured in volume, so
a per-memory sensitivity control would be a switch nobody ever sets. The
`sensitive` row in the duration-ceiling table therefore applies to KB-sourced
basis rows today, and stays available for memories if the axis is ever given a
writer.

## Open questions (Part 2)

1. Should repeated Allow-once for the same (scope, channel, agent) triple prompt
   *"make this standing?"* — proposing only, never auto-granting?
2. Restricted-by-default replies may be frequent in mixed channels until grants
   accumulate. Accept that friction, or narrow autonomous recall first (Part 1 Q2)?
3. Exact duration presets: are *10 minutes / rest of today / 30 days / until
   revoked* the right four, and should "rest of today" use the granter's local
   timezone (recommended) or UTC?

---

# Part 3 — Grants are to places, and knowledge-base sharing

Added 2026-08-11 from two owner decisions.

## The governing principle: a grant names a place, never a list of people

> Whoever is in a channel or project has immediately the same permissions as
> everyone else there, **including the history**. (Owner, 2026-08-11.)

This settles Part 1 Q5 and Part 2 Q2 together, and it applies to **every** grant
family in this document — message-scoped nods, scope disclosure grants, and the
knowledge shares below.

Mechanically it is already free: everything here evaluates at **read time**
against live membership. A person added to `#launch` on Friday passes the same
predicate on Monday's load *and* on every message stamped before they arrived.
No backfill, no per-person fan-out, no propagation job. A departure is symmetric —
they simply stop passing.

**The consequence must be stated plainly, because it relocates the control:
adding someone to a channel or project is itself a disclosure act.** Add a person
to `#launch` and they immediately receive everything ever granted into `#launch`,
retroactively. Channel membership, not the grant click, becomes the thing to be
careful with. Two implications for the build:

- The member-add UI must say so when the destination carries live grants —
  *"#launch has 3 active disclosures; new members can read them, including
  history."* Naming counts, never contents.
- The Disclosures panel is therefore also the answer to "what did we just give
  this person?", and should be reachable from the member-add flow.

We are not building per-person "joined after" cutoffs. A grant to a place whose
members see different slices of that place is not a place any more, and the
bookkeeping would be endless.

## Knowledge-base sharing

> We should be able to attach files from the knowledge base even if they're
> gated — forever. If a user drops a link to a KB file, it should stay available
> unless the user goes back and removes access. Better: a sharing/info panel on a
> document or folder specifying who has access, so I can remove it. After that,
> going back to the file says the file either doesn't exist or you don't have
> access any more. (Owner, 2026-08-11.)

### What exists today

- **Access is per-space only.** `KnowledgeSpaceMember`
  (`api/prisma/schema.prisma:3062-3081`) grants one principal — a user XOR an
  agent — access to a whole space. No expiry, no per-page equivalent.
- **Pages have a tree and two kinds.** `KnowledgePage.parentPageId`
  (`:3091`) with `KnowledgePageKind = document | file` (`:450-453`), so "folder"
  is a page with children.
- **Page-level controls are denials only**, never grants: `sensitivityTier =
  restricted` (humans-only, beating even an agent's explicit grant —
  `packages/knowledge/src/access.ts:89`) and `privateToAgentId`.
- **There is no share concept and no "who has access" view.** Both are new.

### `KnowledgeShare`

```
KnowledgeShare {
  id, organizationId,
  pageId,                       -- the document or folder shared
  includeDescendants  Boolean,  -- true for a folder share
  audienceKind        channel | team | project | user,
  audienceId,
  sharedByUserId,
  sourceMessageId?,             -- set when the share came from a pasted link
  revokedAt?
}
unique (pageId, audienceKind, audienceId)
```

**Durable by design — no expiry.** This is the deliberate opposite of the Part 2
scope grants, and the asymmetry is principled rather than an inconsistency:

| | Scope disclosure grant | Knowledge share |
|---|---|---|
| Covers | future, unseen material from a whole scope | one artifact the sharer has looked at |
| Granted by | answering a card the system raised | a deliberate act of sharing |
| Lifetime | time-capped by tier | until revoked |

Consenting to an agent's ongoing use of a scope is consent to content that does
not exist yet, which is why it has a leash. Handing someone a specific document
is a bounded act about a known thing, so it persists until withdrawn.

### Link-drop is a share

Pasting a KB link into a channel creates the share — that is what makes "attach
files even if gated" work. Two guardrails, because this makes an ordinary paste
consequential:

- **Recorded, not implicit.** A real `KnowledgeShare` row with `sourceMessageId`,
  audit entry, and a place in the access panel. **Not** an unguessable capability
  URL: those cannot be revoked per-recipient, leak by forwarding, and leave no
  list to inspect.
- **A visible, non-blocking notice at share time** naming who gains access, with
  undo — *"Sharing 'Q3 Plan' with #launch (5 people)."* Non-blocking because the
  sharer is entitled and acting deliberately, consistent with the settled position
  that the asker's entitlement governs their own disclosure.

Only a user who can currently read the page may share it, checked server-side at
share time. Agents cannot create shares.

### Folder shares follow the live tree

`includeDescendants` is evaluated against the tree at read time, so a page added
to a shared folder next month is covered without a re-share — the same "grants
name a place" principle applied to the content axis rather than the people axis.
Moving a page *out* of a shared folder removes access, with no cleanup job.

### Revocation and the denial message

Revocation is immediate everywhere, because access is evaluated per read.

Denial is **deliberately ambiguous and identical to not-found**:

> This file doesn't exist, or you no longer have access.

One message, one HTTP status, for revoked access, a deleted page, and a page that
never existed. Distinguishing them would let anyone enumerate the knowledge base
by probing ids, and would confirm the existence of documents whose existence is
itself the sensitive fact.

**Honest limitation:** revoking a share does not retroactively redact content an
agent already quoted into a transcript. Those replies carry their own Part 1 basis
stamps and stay governed by them; the *file* becomes unreachable, but a quotation
already posted remains what it was. Retro-redaction is out of scope here as it is
everywhere else in this document.

### The access panel — the owning surface

On any document or folder, an **Access** panel answering "who can see this":

- inherited space access (read-only here — managed on the space);
- explicit shares, one row each: audience, who shared it, when, source
  ("shared in #launch"), and **Remove**;
- for a folder, a note that shares cascade to everything inside.

Rule zero: this panel is the owning surface, and it is the **same component**
rendering the Part 2 Disclosures list — one access list parameterised by subject
(a page here, a channel there), never two implementations. In-context doorways:
a lock/share affordance on the page header, the same control on the file
attachment card in a message, and a link from the channel Disclosures panel.

### How this composes with Parts 1 and 2

A page shared into `#launch` is readable there, so an agent in `#launch` may read
it and answer from it. That reply is basis-stamped as ever — but the share
already covers `#launch`, so **no consent card fires** for members of that
channel. Sharing a document into a room is exactly the standing permission the
card would otherwise ask for, which is why the two must consult the same
evaluation path rather than each keeping its own.

Two rules survive contact with sharing:

- `restricted` pages remain humans-only. A share makes a page reachable by
  *people* in the audience; it never overrides the agent denial at
  `packages/knowledge/src/access.ts:89`.
- A share grants nothing outside its audience. A `#launch` member cannot use the
  page in `#finance`.

### Phase (Part 3)

Ships after Part 2C, since it reuses the grant-evaluation path and the access-list
component: `KnowledgeShare` migration; share-on-link-drop with the notice and
undo; folder cascade over the live tree; the Access panel; the unified
not-found/no-access response; member-add warning when a destination carries live
grants. Tests: share/revoke round-trip; folder cascade including a page added
after the share; live-membership joiners reading shared history; revoked share and
deleted page returning byte-identical responses; agent denied a `restricted`
shared page; share created by a user who cannot read the page → 403; agent
attempts share creation → no endpoint.

---

## Review record

Designed 2026-08-11 by **Fable** (claude-fable-5) and **Kimix** (Kimi via Codex)
working independently from one brief. Every claim re-verified against the code
before acceptance.

- **Core mechanism: Fable's.** Kimix's whole-run-tuple + intersection predicate
  was rejected on verification — `assembleScopes:202-205` puts the org audience in
  every member's tuple, so the predicate would admit everyone and close nothing.
- **Kimix wrong on KB.** Claimed KB retrieval is agent-scoped and needs a fix;
  `access.ts:57-64` already resolves the user principal when there is an asker.
- **Kimix right on compaction**, which Fable omitted entirely — and it produced
  the checkpoint-basis-union requirement above, without which Phase 1 ships a hole.
- **Converged independently** (and therefore trusted): withheld placeholder over
  silent omission; forward-only with legacy messages unrestricted; asker's
  entitlement governs in shared channels.
- **Unresolved:** the pre-send composer hint.

### Second round — memory tiers and the consent card (Part 2)

Same two designers, same method. Resolved disagreements:

- **Gate placement: Fable's.** Kimix argued for a retrieval gate on the grounds
  that emission-gating leaves privileged text in a window re-read by
  `loadConversation`, the orchestrator, and checkpoints. True *without* Part 1 —
  but both plans sequence Part 1 first, and once the read predicate exists every
  downstream reader is gated, so the objection was against a design nobody
  proposed. Emission-with-nothing-held also avoids penalising the entitled asker,
  who under a retrieval gate would get a degraded answer and then a re-run.
- **"Privileged is a relation, not a tier": Fable's**, and it is the most useful
  correction of the round — it removes a whole table from the design.
- **Firing computation: Fable's** scope-chain form over Kimix's member
  enumeration, which is unstable for a durable artifact — and whose stated
  formula was inverted (see the spec-bug note above).
- **`SensitivityTier` verdict: converged**, and therefore trusted — human-assigned
  second axis whose only job is to withhold the Allow-always option. Fable pinned
  it more precisely ("a live reader with no writer"; production never raises it,
  only test fixtures do).
- **Top tier gets no "always": converged.** Both reached it independently from
  different arguments — a wiretap over future unseen content (Fable); no ambient
  audience to notice misuse (Kimix).
- **Standing-grant key: converged** on `(source scope, destination channel, agent)`
  with live granter-membership recheck. Independent agreement on every dimension
  including the agent term.

## Changelog

- **2026-08-11** — Created from two independent design passes plus verification.
- **2026-08-11** — Part 2 added: memory tiers, the consent card, and provably
  bounded standing grants, from a second two-model design round.
- **2026-08-11** — Standing grants became a tier-capped duration menu
  (10 min / rest of today / 30 days / until revoked); presence-bound grants
  explicitly not built; sensitivity confirmed KB-only.
- **2026-08-11** — Part 3 added: grants name places rather than people (joiners
  get full access including history, which relocates the control to channel
  membership), plus durable, revocable knowledge-base sharing with an access
  panel and an ambiguous not-found/no-access response.
