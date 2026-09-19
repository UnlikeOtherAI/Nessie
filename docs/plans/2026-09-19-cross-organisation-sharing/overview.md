# Cross-organisation project and board sharing

**Date:** 19 September 2026. **Status:** proposed implementation plan; no feature implemented.
**Repository inspected:** `99a17addfac90c2861466e47e56186a9c856c7d1`.

## Executive summary

Keep a project, its boards and their content in the source organisation. Give
one recipient UOA team an explicit, revocable Nessie resource grant. A grant
shares either the project or exactly one board, with read-only or read-write
collaboration. It never creates source-organisation membership, transfers
ownership, grants source administration, or transfers a subscription.

Reuse Projects, the existing board and task dialog, Project Docs, and the
navigation framework. Source managers control grants in project/board Sharing;
recipients find accepted grants in Projects under **Shared with your teams**.
The same underlying components render native and shared resources with
server-returned capabilities. A board share never loads the rest of its project.

This is a security-boundary change, not a sharing dialog over existing project
membership. Four prerequisites block enabling it: live recipient-team authority
without durable UOA membership copies; provable project ownership; resource-level
authorization throughout reads and writes; and disclosure provenance that remains
valid when a conversation gains an external audience. Historical generated
content whose provenance was discarded cannot simply become externally visible.
UOA also needs to supply any commercial sharing eligibility decision: the current
direct-service-access confirmation is not an arbitrary source-team subscription API.

Recommended defaults are team-addressed offers accepted by a recipient team
manager, read-only initially, no re-sharing, source-owned storage, no implicit
external-provider writes or paid agent execution, and explicit recovery after a
suspension. Read-write means editing the shared work, not becoming a source
project administrator. These product decisions are proposals, identified below.

## Table of Contents

- [Product model and exact resource scope](product-and-scope.md): terminology,
  rights, subscriptions, lifecycle, owning surfaces and doorways.
- [Authorization, data and disclosure architecture](architecture.md): schema,
  services, API, cross-tenant identity, provenance, revocation and threat model.
- [Delivery and verification](delivery.md): implementation sequence, concrete
  file map, rollout, migration, tests, open decisions and documentation updates.

## Evidence and precedence

The plan follows [AGENTS.md](../../../AGENTS.md) Rule zero and its routed
standards. The research read the standards and inspected their implementation
seams, rather than treating historical plans as current behavior:

| Evidence | Consequence for this plan |
| --- | --- |
| [Team model](../../standards/team-model.md), `packages/team-admin/src/resource-authority.ts`, `project-structure.ts` | A project has one owning team. Native project membership means broad equal management rights; it cannot encode an external read-only collaborator. `resolveProjectAccess` and `canModifyProject` remain distinct. |
| [Boards overview and as-built](../2026-09-05-project-boards-external-sources-and-custom-fields/as-built.md), `board-placement.ts`, `project-task-move.ts`, `Task.boardId` | Boards own tickets and columns. The older overview, design decisions and some Prisma comments still describe views; those descriptions must not drive this implementation. |
| [Disclosure boundaries](../../standards/disclosure-boundaries.md), `worker/src/run/execute/disclosure-basis.ts`, runtime disclosure readers | Current destination implication removes organisation/team/project provenance. External audiences invalidate that assumption. Run-linked task reads also require the run's channel and basis. |
| [UOA unification plan](../2026-09-02-uoa-as-a-service-unification.md), `request-admission.ts`, `uoa-live-entitlements.ts` | Existing durable identity/membership projections are a documented authority violation/migration gap. Do not extend them. Live checks bind the acting person to their own organisation. |
| [Customer billing](../../standards/customer-billing.md), direct service-access confirmation | Subscription and credit decisions belong to UOA. A successful login is not a permanent sharing entitlement or permission to spend source credits. |
| [Navigation](../../navigation/overview.md), its deep-link, overlay, content/draft and verification chapters; [design system](../../standards/design-system.md) | Reuse registered surfaces, one header, URL-backed tabs, shared dialogs and identity tiles. Retained screens and caches must not retain revoked content. |
| [Capability health](../../standards/capability-health-alerts.md), [alerts](../../standards/user-alerts.md), [approval core rules](../../approval-gating-spec.md) | Persist remedy-bearing transitions, deduplicate alerts, and use conversation cards for agent approvals. No approvals inbox. |
| [Architecture](../../architecture.md), [frontend architecture](../../provider-system-and-frontend-architecture.md), [testing](../../standards/testing.md), [build/migrations](../../standards/build-and-release.md) | Domain services own authorization/audit, frontend imports stay layered, migrations are additive and immutable, database tests run through Turbo, browser suites are explicitly dispatched. |
| [File storage](../../standards/file-storage.md), [agent ownership](../../standards/agent-ownership.md), [personal assistant tools](../../standards/personal-assistant-tools.md), [paired agents](../../standards/paired-agents.md), [global agents](../../standards/global-agents.md) | Grants cannot expose bytes outside FileService, transfer agents, widen paired credentials, or give tools more authority than buttons. |
| [Scoped settings](../../standards/scoped-settings.md), [team hosts](../../standards/team-hosts.md), [horizontal scaling](../../standards/horizontal-scaling/overview.md) | Use existing policy cascade if needed, keep recipient tenant identity in navigation, and enforce revocation across replicas. |

This document is a proposal, not a change to those standards. Implementation
must update the affected standards alongside each changed behavior. Known
inconsistencies are called out in [delivery](delivery.md); no new identity store,
parallel board implementation, or fallback authorization is proposed.
