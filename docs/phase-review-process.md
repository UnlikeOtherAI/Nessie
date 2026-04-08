# Phase Review and Build-Up Process

> Status: active process document.

This document defines the repeatable process for bringing any implementation phase to production-ready completeness. It is referenced by [implementation-phases.md](./implementation-phases.md) and applies to Phases 2–5.

## 1) When to run this process

Run this process:

- before starting implementation of a new phase,
- after writing initial specs for a phase,
- as part of the mandatory end-of-phase review gate (see [implementation-phases.md](./implementation-phases.md) section 1.1).

## 2) Phase build-up steps

### Step 1: Scope inventory

Map every item in the phase's scope list (from implementation-phases.md) to exactly one spec document.

Produce a table:

| Scope item | Spec document | Status |
|---|---|---|
| feature X | `docs/feature-x-spec.md` | complete / incomplete / missing |

Rules:

- every scope item must map to at least one spec,
- if no spec exists, create one,
- if a spec exists but is incomplete, list what's missing.

### Step 2: Spec completeness audit

For each spec document, verify:

1. **Data model** — Prisma model defined? Field types match shared contracts? Indexes specified?
2. **API endpoints** — all paths use `/api/` prefix? Request/response shapes defined? Pagination contract used? Error codes listed?
3. **Shared types** — types that cross service boundaries listed for `packages/schemas`? Branded IDs defined?
4. **MCP parity** — control actions listed with matching names?
5. **Cross-links** — references to all related specs present? No broken links?
6. **Integration points** — audit trail integration defined? Policy enforcement integration defined? Token ledger integration defined (where applicable)?
7. **Frontend integration** — admin UI requirements listed? Facade/hooks requirements noted?
8. **Worker/queue integration** — async job flows defined? Idempotency requirements noted?
9. **Security** — access control model defined? Redaction requirements noted? No plaintext secrets in logs/events?
10. **Phase annotation** — spec clearly states which phase it targets?

### Step 3: Cross-reference validation

Run parallel review agents (Claude, Codex, max) to cross-check:

- spec-to-spec consistency (same types, same field names, same API shapes),
- spec-to-code drift (existing code assumptions that contradict the spec),
- contradictions between specs (same concept defined differently in two places).

### Step 4: Code-level prerequisite scan

Identify Phase N-1 code that must change for Phase N:

- hardcoded values that become dynamic,
- missing authorization checks,
- missing data model fields or relationships,
- missing queue/provider abstractions,
- N+1 query patterns that won't scale,
- realtime event leaks across privacy boundaries,
- idempotency gaps in at-least-once delivery paths.

Document each as a numbered item with file path, line reference, and required change.

### Step 5: Build sequence

Write a step-by-step build order inside implementation-phases.md:

- steps are numbered and ordered by dependency,
- each step references the relevant spec,
- infrastructure/deployment steps come first,
- data model changes come before feature code,
- policy enforcement comes before features that depend on it,
- frontend comes after backend endpoints exist,
- validation/testing is the final step.

### Step 6: Shared contracts update

Add phase-specific types to `packages/schemas` via [shared-type-contracts-spec.md](./shared-type-contracts-spec.md):

- new branded IDs,
- new response types,
- new event payloads,
- new enum values.

Update the "Phase N additions" section in shared-type-contracts-spec.md.

### Step 7: Config update

Add phase-specific configuration to `packages/config` via [config-module-spec.md](./config-module-spec.md):

- new feature flags,
- new provider configs,
- new RuntimeCapabilities flags.

### Step 8: Apply findings to specs

All findings from reviews must be applied directly to the actual spec documents. Do not maintain separate "review findings" documents. The specs themselves are the source of truth.

## 3) Review gate checklist

Before a phase can close, verify:

- [ ] every scope item maps to a complete spec,
- [ ] all specs pass the completeness audit (Step 2),
- [ ] no unresolved cross-reference contradictions,
- [ ] code-level prerequisites documented in implementation-phases.md,
- [ ] build sequence written with spec references,
- [ ] shared contracts updated for the phase,
- [ ] config module updated for the phase,
- [ ] Claude CLI review pass completed,
- [ ] Codex review pass completed,
- [ ] `max` review pass completed,
- [ ] Gemini CLI review pass completed,
- [ ] all verified blocking findings resolved,
- [ ] lint, typecheck, and build gates pass for all affected roots.

## 4) Anti-patterns

- creating standalone "review findings" or "checklist" documents instead of fixing the actual specs,
- leaving scope items without a spec reference,
- defining types in specs without adding them to `packages/schemas`,
- defining API endpoints without the `/api/` prefix,
- defining events without adding them to the canonical event catalog in shared-type-contracts-spec.md,
- skipping the code-level prerequisite scan (Phase N code always has Phase N-1 assumptions baked in).

## 5) Cross-links

- [implementation-phases.md](./implementation-phases.md)
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
- [config-module-spec.md](./config-module-spec.md)
- [hosted-app-architecture.md](./hosted-app-architecture.md)
