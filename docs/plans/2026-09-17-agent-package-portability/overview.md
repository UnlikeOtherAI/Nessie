# Agent packages — export, transfer, and import through the Agent Designer

**Status: design, not built.** Written 2026-09-17 against the code as it stands on
`main` (`52aef2240`). Every "today" statement below was checked against the schema,
the clone route, the blueprint registry and the Designer's tools; every "would"
statement is a proposal. Where a paragraph speculates rather than reports, it says so.

**Related:**
[The Agent Designer](../2026-09-02-agent-designer-global-agent.md) (D1 blueprints, D3
identity-delegated tools, D4 toolset, D7 immutability of system agents),
[Designer grants and the proposal card](../2026-09-16-agent-designer-grants-and-proposal-card.md)
(the card this plan extends),
[Agent documents and learning](../2026-09-08-agent-documents-and-learning.md)
(documents as the durable agent knowledge; §3 is what draws the memory line),
[People and their agents](../2026-08-29-people-and-their-agents.md) and
[agent ownership](../../standards/agent-ownership.md) (who may export),
[Marketplace and agent library](../../marketplace.md) (where a package eventually lists),
[team model](../../standards/team-model.md) and `docs/brief.md` → "Current SSO identity
invariant" (what a package may never carry).

## Outcome

A person can take **the whole of an agent** — its instructions, every document in its
Documents home, its checklists, its avatar, its model and tool choices, its schedules
— and export it as one **package**: a single `.nessie-agent` file, or the same thing
unpacked as a folder of Markdown and JSON a person can read and diff. Dropped into the
Agent Designer's conversation on any Nessie — the same instance, another team's, another
organisation's — the Designer recognises it, checks it, **scans every string in it for
the ways a package can attack its reader**, shows the standard proposal card with a
trust line and a scan line, and behind **Review and approve** puts a plain brief — what
the agent is for, what it will reach, what comes with it, what was found, what it
cannot do until granted — and an acknowledgement that says more the less is known
about the source. On **Approve** it materialises the agent: portrait, documents,
checklists and all, owned by the person who dropped it, placed where they say. The
Agent Designer is the only agent that does this; the Personal Assistant hands a
dropped package to it.

What a package deliberately does **not** carry: conversations, runs, anything derived
from a private conversation, any person, any organisation or team, any credential, any
grant. Those are either history, or authority — and authority is re-decided on the
receiving side, by the receiving people, through the same chokepoints they already use.

An **authorised package** is one whose provenance UnlikeOtherAI has attested: *this
package was exported by organisation X, by one of its members, for organisation Y,
and has not been altered.* The recipient's Designer verifies that without contacting
anybody, tells the person plainly who it is from, and imports with the source's tool
and app choices pre-selected rather than switched off. An unauthorised package imports
too — it is the recipient's own decision, like pasting a prompt somebody sent them —
but it arrives labelled as text from a stranger, with every capability off until ticked.

## Table of Contents

- [What exists today](./01-what-exists-today.md) — the verified state of the schema, the clone route, the blueprint registry and the Designer's tools on 2026-09-17.
- [Design decisions](./02-design-decisions.md) — the package format, what it carries, what it refuses to carry, and how the Designer presents an import.
- [Security, phases and verification](./03-security-phases-and-verification.md) — the invariants a package may never break, the delivery phases, how each is proven, and the questions still open.
