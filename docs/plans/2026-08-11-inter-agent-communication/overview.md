# Inter-agent communication — governed task bus, grants, and audit

**Status:** research captured, current state audited, plan proposed. Not yet implemented.
**Date:** 2026-08-11
**Owner:** Ondrej Rafaj
**Companion:** [2026-08-11-viewer-scoped-agent-knowledge.md](../2026-08-11-viewer-scoped-agent-knowledge.md)
— the entitlement boundary between an agent's knowledge and the person asking it.
This document governs how agents talk to *each other*; that one governs what an
agent may say to *whom*.
**Related:** [`docs/plans/2026-04-06-multi-agent-orchestration.md`](../2026-04-06-multi-agent-orchestration.md),
[`docs/plans/2026-04-15-n8n-inspired-workflow-tools-and-triggers.md`](../2026-04-15-n8n-inspired-workflow-tools-and-triggers.md),
[`docs/security-audit-2026-06.md`](../../security-audit-2026-06.md),
[`AGENTS.md`](../../../AGENTS.md) → Rule zero

---

## Table of Contents

The previous single-file plan is split by responsibility so it remains fully
readable without exceeding the repository documentation size limit.

- [Part 1a — Source brief: foundations](source-brief-foundations.md)
- [Part 1b — Source brief: governance](source-brief-governance.md)
- [Part 2 — Current Nessie state](current-state.md)
- [Parts 3–4 — Benefits, costs, and auditability options](benefits-and-options.md)
- [Part 5 — Proposed implementation plan](implementation-plan.md)
- [Parts 6–7 — Owner decisions and review record](review-record.md)

## Why this document exists

Nessie's premise is that agents behave like employees: they take work, hand work
to each other, report back, and leave a trail a human can inspect. Today they
mostly cannot hand work to each other, and where they can, the mechanism is
invisible and unaudited.

Separately, the July–August 2026 OpenAI/Hugging Face incident demonstrated the
failure mode a platform like Nessie must design against: **any medium one agent
can write and another can read becomes an agent-to-agent protocol.** If we do not
provide a good channel, agents will improvise one out of whatever shared
namespace we left writable — and an improvised channel is by definition
unaudited, unscoped, and unstoppable.

Part 1 preserves the research brief verbatim so nothing is lost. Part 2 onward is
Nessie-specific: what we actually have (code-verified), what is missing, what it
costs, and how to build it.

---
