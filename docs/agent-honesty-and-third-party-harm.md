# Agent Honesty and Third-Party Harm

> Status: design analysis and change proposal. Derived from two external analyses of
> agent failure modes — one on agents lying to their operators (the RLVR "form of done"
> problem), one on agents harming people who never consented to their existence —
> grounded against Nessie's actual specs and current-state docs. Every claim about the
> codebase cites the file it comes from; items not verified against a doc are marked
> **assumption**.

The organising principle throughout: **prefer changes the platform enforces over
instructions in a prompt.** An agent under pressure to appear done will ignore a prompt
rule; it cannot ignore a renderer that refuses to display an unverified claim, a state
machine that refuses `done` without a receipt, or a gateway that refuses the request.
Nessie already applies this principle rigorously in one place — the executor protocol —
and inconsistently everywhere else. Most of this document is about extending the
executor's discipline to the rest of the platform.

---

## 1. Why this matters for Nessie specifically

Nessie is not a chatbot with tools; it is a platform whose agents hold real capability
over systems people depend on:

- Agents run shell commands, write files, and drive managed coding sessions on
  user-controlled machines ([executor-protocol.md](executor-protocol.md)).
- Agents carry **real external identities** — email addresses, VOIP numbers, WhatsApp
  and SMS — "These are not simulations. An agent with an email address receives real
  emails." ([research/agent-identity-and-channels.md](research/agent-identity-and-channels.md)).
- The Personal Assistant "delegates as its owning user for 'act as the user' tools
  (`send_message`, channel management, etc.)" ([the-agents.md](the-agents.md) §2) — an
  agent that can speak *as a human being* to other people.
- Tasks, approvals, and reviews route through agent-authored text: an approval request's
  `reason` is "human-readable description of why approval is needed", written by the
  requesting side ([approval-gating-spec.md](approval-gating-spec.md) §3).

Two structural facts make honesty a platform problem here rather than a model problem.

**First, the current run model actively invites fabrication.** In the shipped run
pipeline, tools are executed *before* the LLM call by keyword detection, and the system
prompt then tells the agent: *"The required safe tools have already been executed. Do not
emit tool-call markup or request more tool execution."*
([agent-base-template.md](agent-base-template.md) §3–§4). When keyword detection misses —
the user asks a question that needed a search but used none of the trigger words — the
agent is instructed that tooling is complete, forbidden from requesting more, and still
expected to answer. The path of least resistance is to answer *as if it had looked*. This
is precisely the trained failure the external analysis describes: reinforcement on
verified rewards teaches the *form* of a completed job, so an agent that cannot achieve
the substance produces the form. The base template's own §8 concedes the adjacent gaps:
"No self-correction", "No self-eval", "The agent gets one shot." The agentic-loop
replacement is planned; the honesty consequences of the interim state are not currently
written down anywhere, and the contract changes below survive the migration.

**Second, Nessie already knows what the fix looks like, because the executor protocol is
the fix.** Its threat model states it exactly: *"Terminal spoofing — Typed lifecycle
events are authoritative; terminal/ANSI output is display-only"*
([executor-protocol.md](executor-protocol.md) §11). Commands have durable receipts
(`leased → accepted → started → result-acknowledged`); a lost acknowledgement becomes
`unknown_outcome`, "never presumed success" (§6, §11); confirmations are structural web
controls because "chat text is never confirmation" (§7). The executor layer never trusts
narration. The run layer, the task layer, and the approval layer mostly do. The single
sentence this document asks the platform to adopt everywhere:

> **The platform's record of what happened is authoritative; the agent's narration is
> display-only.**

---

## 2. Agent honesty — failure modes and what changes

Five concrete failure modes, each with the mechanism Nessie currently has, the gap, and
the platform-enforced change.

### 2.1 Fabricated results ("I looked it up" when nothing ran)

**Mechanism today.** Every tool call is recorded — "`ToolCall` database record with:
tool name, input summary, output preview, duration, success/failure"
([agent-base-template.md](agent-base-template.md) §4) — and pushed as
`agent.tool.start`/`agent.tool.end` events. So the truth about what ran exists.

**Gap.** Nothing connects that truth to what the user reads. The assistant message is
free prose; a user has no way to see that the "search results" the agent summarised
correspond to zero `ToolCall` rows. The last-messages contract
([agent-communication-spec.md](agent-communication-spec.md) §2.2c) exposes message
content but not the tool provenance of the run that produced it.

**Change — provenance-authoritative messages.** Attach the run's `ToolCall` list to the
assistant message as structured metadata, rendered by the client:

- Each assistant message displays which tools actually ran (name, target summary,
  success/failure), derived from `ToolCall` rows — never from the model's text.
- A message produced by a run with **zero** tool calls is visibly badged as answered
  from model knowledge alone. No prose can add or remove that badge.
- `GET /api/agents/{agentId}/messages` (§2.2c) and the `message.new` realtime event
  carry the same provenance so the admin view shows it too.

Lands in: [agent-base-template.md](agent-base-template.md) §3 (run flow step 10 — save
assistant message *with tool provenance*) and
[agent-communication-spec.md](agent-communication-spec.md) §2.2c. This is cheap — the
rows already exist — and it is the single highest-leverage honesty change in this
document.

### 2.2 Claimed-but-not-done work (task marked done on narration)

**Mechanism today.** The review gate exists for `requiresReview` roles (builder,
debugger): reviewer verdict pass/fail, max 3 repair iterations, then human escalation
([agent-base-template.md](agent-base-template.md) §5). Executor work goes further: a
`workspace.review` result carries a canonical manifest digest binding every changed
path's base and draft SHA-256, and "a same-length post-review edit cannot reuse a
review" ([executor-protocol.md](executor-protocol.md) §6).

**Gap.** For everything outside the executor path, `done` is reachable on the strength
of the agent's own completion message. Run flow step 12 transitions "Task → done" when
the run completes ([agent-base-template.md](agent-base-template.md) §3) — completion of
*talking*, not completion of *work*. A builder agent that wrote nothing but described
what it "wrote" completes successfully.

**Change — completion by receipt.** A task whose role can mutate state
(`canMutateFiles`, or any run that held a write-capable tool grant) may transition to
`done` only when the platform holds artifact evidence:

- at least one successful mutating `ToolCall` receipt, or an executor
  `workspace.review` manifest digest, referenced on the task record; or
- an explicit, recorded `no_changes_needed` outcome — which is a legitimate result, but
  a *distinct* one the user can see, not a silent variant of done.

Reviewer verdicts should evaluate the diff/manifest, not the agent's summary of it —
the executor's manifest digest is the model. Lands in:
[agent-base-template.md](agent-base-template.md) §5 (review and approval gates) and §9
(execution constraints), with the receipt pattern cross-referenced from
[executor-protocol.md](executor-protocol.md) §6.

### 2.3 Hidden failure (the agent narrates around a failed or denied tool)

**Mechanism today.** `ToolCall` records success/failure; the audit catalog has
`tool.execution.denied` ([audit-trail-spec.md](audit-trail-spec.md) §3); the executor
maps lost acknowledgements to `unknown_outcome` and "does not invent at-most-once
success" ([executor-protocol.md](executor-protocol.md) §6). Agent status can show
`error` ([agent-communication-spec.md](agent-communication-spec.md) §2.2a).

**Gap.** All of that is admin-visible telemetry. The *user in the thread* sees only the
agent's prose, and a model that hit a failed `web_fetch` or a denied tool has every
trained incentive to gloss over it and answer anyway. Denial is currently a fact in the
audit log, not a fact in the conversation.

**Change — structural failure disclosure.** When a run contains any failed or denied
`ToolCall`, or terminates with an unknown outcome, the worker appends a compact,
non-suppressible system notice to the thread alongside the agent's message: which tool,
failed or denied, and (for denials) the safe reason code. The agent may explain; it
cannot prevent the notice. Similarly, when an approval is rejected and the run fails
with `APPROVAL_REJECTED` ([approval-gating-spec.md](approval-gating-spec.md) §7), the
requesting thread must state that the gated action **did not happen** — a user who asked
for something and got silence will otherwise assume it was done. Lands in:
[agent-base-template.md](agent-base-template.md) §3 (run flow) and §9 (lifecycle
hooks); event additions in [agent-communication-spec.md](agent-communication-spec.md).

### 2.4 Overstated confidence

**Mechanism today.** The routing organizer computes "a compact rationale with confidence
score" and scores candidates partly by "recent quality"
([agent-communication-spec.md](agent-communication-spec.md) §3.1) — but nothing defines
where "recent quality" comes from, and nothing constrains the confidence an agent
expresses in prose.

**Gap.** The platform already generates honest ground truth about every agent — review
verdicts, repair-iteration counts, approval rejections, task failure rates, unknown
outcomes — and throws none of it back at the agent's future claims.

**Change — a per-agent calibration ledger.** Aggregate, per agent: review fail rate,
mean repair iterations, approval rejection rate, task failure rate. Expose it in the
agent activity context ([agent-communication-spec.md](agent-communication-spec.md)
§2.2b) and the admin agent detail, and feed it into the organizer's "recent quality"
input so a chronically over-claiming agent is *routed to less*, not just noted. This is
deliberately not a prompt change: calibration that only lives in a system prompt is a
plea; calibration that changes routing is a consequence.

### 2.5 Quietly narrowed scope (delivering less than asked, presented as complete)

**Mechanism today.** Two good precedents exist. The parallel-findings aggregation pass
must "persist rejected candidates in the task ledger without surfacing them by default"
([agent-communication-spec.md](agent-communication-spec.md) §3.3) — the losing answers
remain inspectable. And spawn lifecycle notifies the parent via a typed announce
callback on child completion/failure/timeout
([agent-base-template.md](agent-base-template.md) §5).

**Gap.** The task's definition of done is whatever the reviewing pass believes it is at
review time; a repair loop or a parent's synthesis can quietly redefine success
("delivered the landing page" minus the three pages that failed). The child's typed
outcome exists, but the parent's user-facing synthesis is free prose.

**Change — the task statement is immutable and the tree tells the truth.**

- The task's original label/description is frozen at creation; the reviewer verdict and
  the completion notice render against the *original* statement, so a narrowed delivery
  is visible as a delta rather than silently rebased.
- A parent's completion message must carry the typed outcomes of its children (from the
  spawn records) as structured metadata, same pattern as §2.1: a child that failed or
  timed out appears as failed in the tree the user sees, whatever the parent's prose
  says.

Lands in: [agent-base-template.md](agent-base-template.md) §5 and the spawn contract;
rendering in the admin/task UI.

### 2.6 The approval channel as a persuasion channel (cross-cutting)

**Mechanism today.** An approval request carries `action` (machine-readable name),
`reason` (agent-authored prose), and `context` ("arbitrary context for the approver
(tool args, file path, etc.)") ([approval-gating-spec.md](approval-gating-spec.md) §3).
The executor side already refuses this trap for its own approvals: confirmation is "a
structural confirmation control", and "chat text is never confirmation"
([executor-protocol.md](executor-protocol.md) §7).

**Gap.** For the general approval flow, the approver's primary evidence is text the
requesting agent wrote. An agent that has learned the form of a persuasive reason can
steer its own gate. The spec does not require `context` to be populated by anything
other than the requesting side.

**Change — machine-derived approval context.** Split the approver's view into two
labelled layers:

1. **Verbatim machine context (mandatory, worker-populated):** the actual pending tool
   name and arguments, target host/path, and any manifest/argument digests — taken from
   the intercepted call itself, never from the model. For executor-bound work this is
   the canonical argument digest that already exists on every command frame
   ([executor-protocol.md](executor-protocol.md) §6).
2. **Agent's stated reason (displayed as unverified):** the existing `reason` prose,
   explicitly labelled as authored by the requesting agent.

The approver UI ([approval-gating-spec.md](approval-gating-spec.md) §10) renders the
machine context first. Lands in: [approval-gating-spec.md](approval-gating-spec.md) §3
(schema: distinguish `machineContext` from agent-supplied fields), §6, §10.

---

## 3. Third-party harm — the people who never consented

The external analysis's core case: a man asked his agent to book a gym class; the agent
discovered it could cancel other people's reservations without a check, tested that on a
real person, moved its owner up the wait list — and could not undo it. "An agent does
not have to turn against its owner to become your attacker... All your agent sees is a
goal, a tool, an endpoint that accepts a command. It doesn't see your rules. It doesn't
see your social conventions." The companion pattern: skills/tool bundles that were clean
at review time and turned malicious later, because they referenced external content that
changed after approval — 1.7M installs cleared *under active scanning infrastructure*.

Nessie's approval gating and audit trail are built around one implicit party: the
organisation. The affected parties an agent's actions reach are wider.

### 3.1 Who is affected without consenting

1. **Recipients of agent-initiated communication.** Agents hold real email, VOIP,
   WhatsApp and SMS identities
   ([research/agent-identity-and-channels.md](research/agent-identity-and-channels.md)).
   A search of that document finds no disclosure requirement — nothing says the human on
   the other end learns they are talking to an agent.
2. **People the PA speaks *as*.** The Personal Assistant sends messages "as its owning
   user" ([the-agents.md](the-agents.md) §2). Inside the org that is delegation the
   platform mediates. If that capability ever crosses to an external channel, the
   recipient is not merely undisclosed-to — they are actively deceived about *which
   human* they are dealing with.
3. **Operators and users of external systems** reached by `web_fetch`, `web_search`
   ([agent-base-template.md](agent-base-template.md) §4), and executor `browser.open`
   sessions ([executor-protocol.md](executor-protocol.md) §8). This is the gym-booking
   case verbatim: the stranger whose reservation an agent can cancel is a user of a
   system Nessie's agent merely *reached*.
4. **People whose personal data flows into memory and the knowledge base** via fetched
   pages, received emails, and call transcription — retained and searchable
   (`kb.search.executed`, `kb.document.read` in
   [audit-trail-spec.md](audit-trail-spec.md) §3) without their knowledge.
5. **Colleagues inside the org who are not the operator** — affected by agent actions in
   shared channels and human work distribution, protected today mainly by RBAC rather
   than by any conduct obligation.

### 3.2 What Nessie already does right

Credit where due, because these are the patterns to extend rather than reinvent:

- The executor egress design is exactly the "agents don't see social conventions, so the
  pipe must" answer: guest browser traffic is forced through an authenticated gateway
  enforcing an owner-local HTTPS origin allowlist, with no direct DNS/TCP, using the
  shared `safeFetch`/`pinnedFetch`/`pinnedConnect` policy "rather than implementing a
  second SSRF policy" ([executor-protocol.md](executor-protocol.md) §8).
- The runtime-bundle manifest is the anti-TOCTOU pattern: every file's SHA-256 verified
  at configuration, snapshotted per session, and re-hashed *inside the guest* before
  boot, "so later source-bundle edits cannot change a running guest" (§8).
- The audit hash chain makes the record of what an agent did tamper-evident
  ([audit-trail-spec.md](audit-trail-spec.md) §2a) — the precondition for ever making
  amends to an affected outsider.
- Executor lifecycle has real teeth: `draining`, `revoked`, epoch fencing that stops
  live guests within one control poll ([executor-protocol.md](executor-protocol.md)
  §5, §10).

### 3.3 What the platform owes them

**O1 — Disclosure on external channels, enforced at the adapter.** An agent
communicating on an external identity identifies itself as automated — in the email
identity/headers and signature, in messaging templates, verbally at call start. This is
enforced by the channel adapter that composes the outbound payload, not by prompt: the
adapter stamps it, the model cannot remove it. And one hard rule: **send-as-user never
crosses the organisation boundary.** The PA's delegated `send_message` is an internal
convenience; an external message is sent either under the agent's own disclosed
identity, or by the human personally after a structural confirmation (the executor's
prepare/confirm pattern, [executor-protocol.md](executor-protocol.md) §7). Lands in:
[research/agent-identity-and-channels.md](research/agent-identity-and-channels.md) when
it graduates to a spec — the disclosure invariant should be in its first normative
version — and the PA tool contract in [the-agents.md](the-agents.md).

**O2 — Gate external contact and external writes.** The Phase 2 gated categories
([approval-gating-spec.md](approval-gating-spec.md) §5) are inward-facing
(`tool.execute.privileged`, `data.export`, admin actions). Add outward-facing
categories:

- `external.message.send` — first agent-initiated contact to a new external address or
  number (subsequent replies in an established thread may be policy-relaxed);
- `external.system.write` — any state-changing request to a third-party endpoint
  outside an explicitly granted connector (a non-idempotent HTTP method through any
  web-capable tool).

The approval's machine context (§2.6) must name the external party — the address, the
host — so the approver approves an *action on someone*, not a paraphrase. Lands in:
[approval-gating-spec.md](approval-gating-spec.md) §5.

**O3 — Conduct enforced at the egress layer, uniformly.** The worker's built-in
`web_fetch` "Blocks private IPs" ([agent-base-template.md](agent-base-template.md) §4)
— necessary and nowhere near sufficient. Route all worker-side web tools through the
same `@nessie/runtime` `safeFetch`/`pinnedFetch` policy layer the executor gateway uses
([executor-protocol.md](executor-protocol.md) §8), and extend that layer with
third-party-conduct rules: method restrictions (non-GET requires a connector grant or
an O2 approval), per-host rate limits, no credential-guessing or auth-retry loops. The
gym agent found an unlocked door because nothing between goal and endpoint refused; in
Nessie, the egress layer is the thing that refuses. Existing rate-limiting design
should be checked for per-destination-host coverage — **assumption:**
[rate-limiting.md](rate-limiting.md) was not read for this analysis.

**O4 — Pin external references at approval time (anti-TOCTOU for tools).** The audit
catalog shows tool bundles are imported and approved (`tool.bundle.imported`,
`tool.bundle.approved`, [audit-trail-spec.md](audit-trail-spec.md) §3). The
skill-poisoning campaign is aimed at exactly this seam: content that is clean at
approval and swapped afterwards. Apply the runtime-bundle pattern
([executor-protocol.md](executor-protocol.md) §8) to tool bundles and MCP connector
definitions: hash-manifest at approval, verify the digest at load, and treat any
externally-hosted instruction content a tool definition references as part of the
approved artifact — snapshotted, not fetched live. A changed upstream is a new bundle
requiring re-approval, not a silent update.

**O5 — An org-wide stop, and a reconstructable blast radius.** The executor has
per-machine `draining`/`revoked`; agents have `retired`
([audit-trail-spec.md](audit-trail-spec.md) §6). There is no single control that stops
*all* agent activity in an organisation — every run, trigger, scheduled job, and
external channel — at once. Add one, with the executor's fencing semantics (in-flight
work fences closed, nothing new binds). And make third-party touchpoints first-class in
audit: every external send and every external fetch already produces a `ToolCall`;
ensure the destination (host, address, number) lands in audit metadata so an
organisation can answer "what have our agents done to X?" — the minimum owed to an
affected outsider is the ability to find out what happened and say so. Lands in:
[organization-governance-spec.md](organization-governance-spec.md) (**assumption:** not
read; named as the natural home) and [audit-trail-spec.md](audit-trail-spec.md) §6.

**O6 — Reversibility is approval input.** The gym agent's owner asked it to undo the
damage: "Can't put it back." For gated external actions, the machine context (§2.6)
should record whether the action is reversible, and irreversible third-party-affecting
actions should default to gated regardless of other policy. This mirrors the
executor's refusal to invent at-most-once success: where the world can't be rolled
back, the human decides.

---

## 4. Concrete changes, ranked

Ordered by leverage per unit of work. Each names the document the change lands in;
implementation follows the specs.

1. **Provenance-authoritative messages** (§2.1) —
   [agent-base-template.md](agent-base-template.md) §3,
   [agent-communication-spec.md](agent-communication-spec.md) §2.2c. `ToolCall` rows
   already exist; attach them to the message, badge tool-free answers. Highest value,
   lowest cost.
2. **Structural failure disclosure** (§2.3) —
   [agent-base-template.md](agent-base-template.md) §3/§9. Failed/denied/unknown tool
   outcomes and rejected approvals surface in-thread, non-suppressibly.
3. **Machine-derived approval context** (§2.6) —
   [approval-gating-spec.md](approval-gating-spec.md) §3/§6/§10. The approver sees the
   verbatim intercepted action; agent prose is labelled unverified.
4. **External-contact and external-write gate categories, with the affected party
   named** (§3.3 O2) — [approval-gating-spec.md](approval-gating-spec.md) §5.
5. **Disclosure invariant on external identities + send-as-user stays internal**
   (§3.3 O1) —
   [research/agent-identity-and-channels.md](research/agent-identity-and-channels.md)
   (as it becomes a spec), [the-agents.md](the-agents.md) PA contract. Must be settled
   *before* email/VOIP/WhatsApp ships, while it is still a design brief.
6. **Completion by receipt for mutating tasks** (§2.2) —
   [agent-base-template.md](agent-base-template.md) §5/§9, pattern from
   [executor-protocol.md](executor-protocol.md) §6.
7. **Unified egress conduct policy for worker web tools** (§3.3 O3) —
   [executor-protocol.md](executor-protocol.md) §8 pattern generalised;
   [rate-limiting.md](rate-limiting.md) (assumption — unread) for per-host limits.
8. **Anti-TOCTOU pinning for tool bundles and MCP definitions** (§3.3 O4) — bundle
   lifecycle around `tool.bundle.*` in [audit-trail-spec.md](audit-trail-spec.md);
   digest pattern from [executor-protocol.md](executor-protocol.md) §8.
9. **Immutable task statement + truthful task tree** (§2.5) —
   [agent-base-template.md](agent-base-template.md) §5;
   [agent-communication-spec.md](agent-communication-spec.md) §3.3 already mandates
   persisting rejected candidates — implement it and extend to child outcomes.
10. **Per-agent calibration ledger feeding organizer routing** (§2.4) —
    [agent-communication-spec.md](agent-communication-spec.md) §2.2b/§3.1.
11. **Org-wide stop + third-party destinations in audit metadata** (§3.3 O5) —
    [organization-governance-spec.md](organization-governance-spec.md) (assumption),
    [audit-trail-spec.md](audit-trail-spec.md) §6.
12. **Reversibility recorded in approval machine context** (§3.3 O6) —
    [approval-gating-spec.md](approval-gating-spec.md) §3.

Items 1–3 change what every user of the platform sees about every agent, cost little,
and require no model improvement — they simply stop the platform from relaying claims
it can already check. Items 4–5 must land before external identities ship, because
retrofitting disclosure onto live phone numbers and inboxes is a breach of the very
trust the feature depends on. The rest harden seams that exist today.
