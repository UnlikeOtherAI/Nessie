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

## Changelog

- **2026-08-11** — Created from two independent design passes plus verification.
