# Nessie — Claude Code

Multi-tenant, self-hosted agentic work platform. Organisations host their own
Nessie instance; users collaborate in a hierarchy of Organisation → Project →
Team → Channel, with RBAC, approval gates, an audit trail, a token-cost ledger,
MCP connector management, triggers/scheduling, video calling, and human work
distribution.

## Read [AGENTS.md](AGENTS.md) before you do anything

[`AGENTS.md`](AGENTS.md) is the authoritative standards file and the project
map: Rule zero, workflow, ports, the build and deployment story, and the
invariants that apply wherever you are working. It is **not** imported into
this file — open it.

> **Rule zero — a capability is not done until a person can reach it.** A
> feature nobody can navigate to counts as unfinished. The four checks and the
> history behind each are in [`AGENTS.md`](AGENTS.md) → "Rule zero".

## Per-subsystem rules live in `docs/standards/`

One file per subsystem, deliberately **not** loaded into every session.
[`AGENTS.md`](AGENTS.md) → "Architecture" routes to them: each entry names the
invariant in a sentence and links the file that states it in full.

That sentence is a signpost, not a specification. It tells you whether a rule
is in play; it deliberately omits the identifiers, the failure the rule was
written after, and the corollaries that make it followable. **When your change
touches a routed area, open the linked file before writing code.**

When a rule changes, its standards file changes in the same turn. The routing
sentence changes only if the invariant itself did.

## Notes specific to Claude Code

- **Verification is Playwright, headless, against `http://localhost:5455`.**
  Every UI change is screenshotted and confirmed rendering before the work is
  considered done — see [`AGENTS.md`](AGENTS.md) → "Verification". Do not ask a
  person to check a screen you can open yourself.
- **Ports are non-negotiable:** API `5454`, admin `5455`. Never start either on
  another port to work around a conflict.
- **Worktrees are mandatory** and the main checkout stays on `main`. Full rule,
  including the merge-and-clean-up step, in [`AGENTS.md`](AGENTS.md) →
  "Workflow".
- **Voice** is a secondary control surface, not the primary interface — that is
  the admin web UI (`admin/`). Two independent things carry the name: calling
  the Personal Assistant (Gemini Live, browser + iPhone,
  [`docs/standards/voice-calling.md`](docs/standards/voice-calling.md)) and an
  older, architecturally separate OpenAI-Realtime companion in `macos/`.
