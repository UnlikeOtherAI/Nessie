# Part 6 — Open decisions for the owner

1. **Transport for the bus.** Reuse threads/`Message` for conversational hand-offs
   and keep `agent_task_events` for structured coordination (my recommendation), or
   put everything on the event table and project it into threads?
2. **Does `spawn_subtask` survive?** Folding it into mailbox delegation removes the
   permanent-agent problem but changes an existing behaviour.
3. **Capability addressing.** Do we introduce `agent_capabilities` in Phase 1 (so
   agents address `capability:review`), or start with reachable-agent addressing and
   add capabilities in Phase 2?
4. **Grant UI owner.** Which surface owns grants — the Agent Designer, the task
   screen, or a new Ops view? Rule zero says this must be answered *before* Phase 2
   starts.
5. **Scope of "employee".** Does an agent get a persistent inbox it checks on a
   schedule (a real employee mailbox), or only a per-task inbox? This decides
   whether `AgentMailboxMessage` stays task-scoped or becomes agent-scoped.
6. **Where agent mail lands (G18).** Directed mail currently writes into a shared
   channel thread every participant can read. Human-visible thread (noisy, but
   reachable) or a separate agent DM (quiet, but a Rule-zero reachability
   problem)? This was not considered in the first draft.

---

# Part 7 — Review record

Reviewed 2026-08-11 by three independent models against the tree at
`claude/inter-agent-communication-plan-b20c44`: **Kimix** (Kimi via Codex),
**Fable** (claude-fable-5), and **Codex Sol** (gpt-5.6-sol). Every claim below
was re-verified against the code before being accepted; two reviewer claims were
rejected on verification.

**Accepted, changing the plan materially:**

- **G11 (`delegate` bypass) — Sol.** Verified: `executeGuardedBuiltin` skips
  `evaluateToolInvokePolicy`, and `delegate`'s tool callbacks are no-ops. This
  displaced G2 as the highest-severity gap and became Phase 0 item 1, because it
  is live and agent-reachable rather than latent.
- **G2 fix is write-side, not prompt-side — Fable.** Verified: `prompt.ts:40-58`
  already attributes foreign-agent turns; the mailbox routes around it by writing
  `role: 'user'`. A prompt-only fix would have forked the rendering.
- **`promptOverride` and `triggerIsHuman` — Kimix.** Verified: the trigger prompt
  never passes through the `Message` row, and the engagement path classifies
  mailbox deliveries as human turns.
- **Keep `agent_task_events` separate but slim it — Fable.** Verified:
  `TaskEvent` cascades and has no `organizationId`.
- **Depth stays at 1 through Phase 1 — Fable.** Depth 3 over copied authority is
  worse than depth 1.
- **A minimal grant precedes `delegate_task` — Sol.**
- **Structural-only channel-abuse signals — all three, independently.**
- **G12–G20**, contributed across all three reviews.

**Rejected on verification:**

- *"An admin surface references the mailbox"* (Kimix, Sol). A case-insensitive
  search for `mailbox` across `admin/src` returns **0**. `OpsHealthPage.tsx`
  renders a generic `deadLetters` field, never the mailbox concept — which G5
  already stated. Kimix's grep matched on its own `deadLetter` alternative.
- *"Merge into `TaskEvent`"* (Kimix). Overturned by the cascade-delete and
  missing-`organizationId` facts; dissent recorded in Part 4 Option B.

**Corrected factual errors in Part 2:** backoff described as exponential (it is
fixed 10/30/60 s, with invalid destinations dead-lettered immediately);
`delegate` described as "well-bounded"; `spawn_subtask` described as pure copy
(protected grants *are* stripped — attenuation is incomplete, not absent);
`TaskEvent` described as append-only (convention, not constraint); `ToolCall`
described as complete (main loop only); cancellation described as propagating (it
does not); `allowedRoots` described as a sandbox (path confinement, not OS
isolation); G10 described as wholly missing (policy denials are already
structured).

---

## Changelog

- **2026-08-11** — Created. Brief preserved verbatim (Part 1); current state
  audited against `claude/inter-agent-communication-plan-b20c44` (Part 2);
  benefits/costs, audit options, and phased plan proposed (Parts 3–6).
- **2026-08-11** — Revised after three independent code reviews (Part 7). Added
  G11–G20; re-sequenced Phase 0 around closing the `delegate` authorization
  bypass; changed the G2 fix from prompt-side to write-side; slimmed Option B and
  recorded the `TaskEvent` dissent; held delegation depth at 1 through Phase 1;
  added a deferred-scope table; corrected eight factual errors in Part 2.
