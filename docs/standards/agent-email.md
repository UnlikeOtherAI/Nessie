# An agent's mailbox is its own store

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **An agent's mailbox is its own store, and everything about it is
  structural.** Hosted agent email (`support@nessie.works`, Amazon SES
  integrated directly, off unless four `NESSIE_EMAIL_*` variables are set) keeps
  mail in `email_messages` rather than `Message` rows, with one backing
  `agent_email` channel per mailbox and one thread per conversation as the
  operations room. Four invariants carry it, each closing a fail-open: inbound
  **routes on the SES receipt envelope**, never the sender-written MIME headers,
  which omit Bcc and can name another tenant; delivery is **claimed once on the
  receipt id in the same transaction that wakes the run**, so an SNS retry
  cannot double-send or double-spend, while the forgeable `Message-ID` stays a
  threading index that degrades to a new conversation; **waking is a header
  fact** (`bulk`/`dsn`, failed spam/virus/auth verdicts store without spending a
  run) and never a keyword list; and **sending is gated structurally in
  `email-send-gate.ts` through `forceApproval`**, not in `PolicyRule` rows,
  because `evaluateToolInvokePolicy` defaults to allow and seeds no send rule —
  a policy-only gate would be absent wherever nobody configured one. That gate
  additionally forces an approval, naming the sources, whenever a run consumed
  anything beyond its own mailbox and thread; `email:{mailboxId}` is the scope
  that makes "answered from this correspondence" distinguishable, and it must
  stay implied by the mailbox's own thread or every reply deadlocks (four tests
  pin this). A send is `queued` → conditional `sending` → `sent`, with an
  ambiguous outcome parked at `delivery_unknown` and **never retried** — a retry
  is a duplicate in someone's inbox, and a sweep resolves a claim whose worker
  died so it cannot sit in `sending` forever. That claim stops one ROW being
  sent twice; what stops two ROWS existing is `EmailMessage.sendKey`, the tool
  call's own `{runId}:{toolCallId}`, because a replayed run re-issues the same
  call. Suppression and the hourly cap are enforced **inside** the queueing
  write rather than beside it — a check a caller must remember is a check a
  caller can forget, and counting outside the transaction let two concurrent
  runs both pass the last slot. An email attachment asks the same
  agent-visibility question the mailbox reads ask, so the byte surface and the
  conversation surface close together. Deleting a mailbox retires its address
  permanently. Details: `CLAUDE.md` → "Agent email"; plan:
  `docs/plans/2026-09-02-agent-email.md`; AWS setup: `docs/deployment.md`.

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "Agent email — an agent's own mailbox".


Every agent can hold its own address (`support@nessie.works`): people CC it into
a thread and it replies. **Amazon SES is integrated directly** — the
deployment's own account sends and receives, an address is unique per
deployment, and the feature is OFF unless four `NESSIE_EMAIL_*` variables are
set (partial configuration is *named*, never degraded). Mail is **its own
store**, not `Message` rows; each mailbox owns one backing channel
(`ChannelSystemType.agent_email`) with one `Thread` per `EmailConversation` —
the *operations room* for run reports and approval gates, while
`/agents/:agentId/mailbox` is the mail itself. Invariants:
above; plan and build detail (the
`email:{mailboxId}` disclosure scope and its non-deadlock property, the
`forceApproval` send gate, the rendered-draft approval route, attachment
linking):
[docs/plans/2026-09-02-agent-email.md](../plans/2026-09-02-agent-email.md);
operator guide: [docs/agent-email.md](../agent-email.md). Model A of that plan
— an agent operating an *existing* mailbox over Gmail or SMTP/IMAP, with no
interface — is deliberately not built.
