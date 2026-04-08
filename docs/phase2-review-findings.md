# Phase 2 Review Findings

> Consolidated from 12 parallel review agents (6 Spark cross-reference, 6 Haiku implementation readiness).
> Date: 2026-04-08

## Executive Summary

Phase 2 has complete specs for all major features but **zero implementation**. Three new specs were written during this review (approval-gating-spec.md, audit-trail-spec.md, phase2-gcp-deployment-spec.md). Cross-reference review found **4 critical blockers**, **12 spec contradictions**, and **~65 implementation gaps**. The critical path runs through the policy enforcement layer -- everything else depends on it.

---

## 1) Critical Blockers (Must Fix Before Any Phase 2 Code)

### 1.1 RunStatus missing `waiting_approval`

- **Problem**: approval-gating-spec says "Worker transitions the run to `waiting_approval` status" but `RunStatus` in shared-type-contracts-spec and Prisma schema only has: `pending | running | completed | failed | cancelled`.
- **Fix**: Add `waiting_approval` to `RunStatus` in packages/schemas and Prisma enum.
- **Files**: packages/schemas/src/index.ts, api/prisma/schema.prisma, shared-type-contracts-spec.md

### 1.2 No policy enforcement layer exists

- **Problem**: Phase 2 requires basic effective policy checks for channel access, agent binding, and tool visibility. No policy evaluation engine, no policy storage models, no access-check endpoint.
- **Fix**: Write policy-enforcement-spec.md, add policy Prisma models, implement deterministic policy resolver.
- **Scope**: Affects every Phase 2 feature that gates visibility or access.

### 1.3 JWT incompatible with multi-project users

- **Problem**: Phase 1 JWT hardcodes one org/project/team per token. Phase 2 requires users in multiple projects.
- **Fix**: Change JWT claims to support project switching (either list of project memberships or re-issue token on switch).
- **Files**: api/src/auth/session.ts, api/src/index.ts (buildLocalSession)

### 1.4 `approval.resolved` missing from WsEventMap

- **Problem**: approval-gating-spec defines `approval.resolved` WebSocket event but it's not in the canonical event catalog.
- **Fix**: Add to WsEventMap in packages/schemas and shared-type-contracts-spec.md.

---

## 2) Spec Contradictions Found

| # | Issue | Docs | Severity |
|---|-------|------|----------|
| 1 | RunStatus missing `waiting_approval` | approval-gating-spec vs shared-type-contracts | CRITICAL |
| 2 | `approval.resolved` not in WsEventMap | approval-gating-spec vs shared-type-contracts | CRITICAL |
| 3 | Token ledger `requestId` optional vs required in ActionContext | token-ledger-spec vs shared-type-contracts | HIGH |
| 4 | Token ledger `actorId` flat vs nested `actor.actorId` | token-ledger-spec vs shared-type-contracts | HIGH |
| 5 | Audit `outcome` vs governance `decision` naming | audit-trail-spec vs org-governance-spec | MEDIUM |
| 6 | Audit missing `policySource` and `evidence` fields from governance spec | audit-trail-spec vs org-governance-spec | HIGH |
| 7 | Audit missing `correlationId` (only stores requestId) | audit-trail-spec vs hosted-app-architecture | MEDIUM |
| 8 | Token ledger API paths missing `/api/` prefix | token-ledger-spec vs hosted-app-architecture | LOW |
| 9 | Pub/Sub topics don't match architecture logical topics | phase2-gcp-deployment vs hosted-app-architecture | MEDIUM |
| 10 | Cloud SQL Unix socket vs Cloud SQL Node.js connector | phase2-gcp-deployment vs hosted-app-architecture | MEDIUM |
| 11 | API service account missing GCS write permissions | phase2-gcp-deployment internal | LOW |
| 12 | `team-override` pricing source vs governance rule that teams don't define pricing | token-ledger-spec vs org-governance-spec | LOW |

---

## 3) Missing Specs

| Spec | Status | Priority |
|------|--------|----------|
| policy-enforcement-spec.md | NOT WRITTEN | CRITICAL -- blocks all visibility/access work |
| Project/team CRUD workflows | Only discovery in governance spec | HIGH |
| User invitation workflow | Not specified | MEDIUM (keep bootstrap for Phase 2) |
| Effective policy resolution algorithm | Mentioned but no algorithm | HIGH |

---

## 4) Schema Gaps (Prisma Models Needed)

### New models required:
- `ApprovalRequest` (approval gating state machine)
- `AuditLog` (immutable control-plane audit entries)
- `TokenLedgerEvent` (model usage tracking)
- `ModelPricingProfile` (pricing overrides)
- Policy models: `OrganizationPolicy`, `ProjectPolicy`, `TeamPolicy`, `ChannelPolicy` (or a single polymorphic `Policy` table)

### Existing model changes:
- `RunStatus` enum: add `waiting_approval`
- `Channel`: enforce visibility in queries
- `Project`: add `status` field (active/archived/degraded) for lifecycle
- `ChannelMember`: add `role` field for member-level permissions
- `Agent`: consider `visibility` field or rely on binding-based visibility

---

## 5) API Gaps (Endpoints Needed)

### Approval gating (5 endpoints):
- `POST /api/approvals`
- `GET /api/approvals`
- `GET /api/approvals/:approvalId`
- `POST /api/approvals/:approvalId/resolve`
- `GET /api/approvals/pending/count`

### Audit trail (3 endpoints):
- `GET /api/audit-log`
- `GET /api/audit-log/:entryId`
- `GET /api/audit-log/summary`

### Token ledger (7 endpoints):
- `POST /api/ledger/tokens/events`
- `GET /api/ledger/tokens/summary`
- `GET /api/ledger/tokens/events`
- `GET /api/ledger/tokens/pricing`
- `POST /api/ledger/tokens/pricing`
- `DELETE /api/ledger/tokens/pricing/:profileId`
- `GET /api/ledger/tokens/monthly-estimate`

### Project/team CRUD (~10 endpoints):
- `GET/POST /api/projects`, `GET/PATCH /api/projects/:id`
- `GET/POST /api/projects/:id/members`, `DELETE /api/projects/:id/members/:userId`
- `GET/POST /api/teams`, `GET/PATCH /api/teams/:id`
- `GET/POST /api/teams/:id/members`, `DELETE /api/teams/:id/members/:userId`

### Discovery and search (~6 endpoints):
- `GET /api/agents/search`
- `GET /api/tools/search`
- `GET /api/teams/:teamId/channels`
- `GET /api/channels/:channelId/members`
- `POST /api/channels/:channelId/members`
- `GET /api/access/check`

**Total: ~31 new endpoints**

---

## 6) Worker Gaps

- Emit token ledger events after every model call
- Detect gated actions and create approval requests
- Pause run on approval-required, emit `approval.needed` event
- Resume run on `run.resume` queue job with continuation token verification
- Emit audit events for worker-side mutations

---

## 7) Frontend Gaps

### New facades (6):
- `approvals/`, `audit/`, `token-ledger/`, `projects/`, `teams/`, `policies/`

### New pages (7):
- ProjectsPage, TeamsPage, ApprovalsPage, AuditLogPage, BillingPage (token usage), ProjectDetailsPage, TeamDetailsPage

### New components (~13):
- ProjectSelector, TeamSelector, ApprovalCard, ApprovalDrawer, AuditLogTable, TokenUsageChart, TokenBreakdownTable, CostEstimate, ChannelVisibilityBadge, MemberBadge, MemberRoleDropdown, MemberInviteForm, ApprovalStatusBadge

### New routes (7):
- `/projects`, `/projects/:id`, `/teams`, `/teams/:id`, `/approvals`, `/audit`, `/billing`

### Provider changes:
- AuthSessionProvider: add project/team switching
- WebSocket: handle `approval.needed`, `approval.resolved` events

### Settings refactor:
- Break current 422-line SettingsPage monolith into separate pages

---

## 8) GCP Infrastructure Gaps

### Missing entirely:
- All Terraform configs (Cloud Run, Cloud SQL, Pub/Sub, GCS, KMS, IAM, networking)
- PubSubQueueProvider adapter
- GcsStorageProvider adapter
- Cloud Build CI/CD pipeline
- Admin nginx.conf for static hosting
- Worker HTTP server for Eventarc push delivery

### Spec issues to fix:
- Redis/Memorystore not in deployment spec (architecture requires it)
- Runner service phase assignment unclear (Phase 2 or Phase 4?)
- Load balancer config incomplete
- Secret rotation strategy not addressed
- Cost estimate underestimates by ~$100-150/month (missing VPC connector, egress)

---

## 9) Recommended Build Sequence

### Sprint 0: Fix Blockers (1 week)
1. Add `waiting_approval` to RunStatus
2. Add `approval.resolved` to WsEventMap
3. Fix token ledger field mismatches in schemas
4. Write policy-enforcement-spec.md
5. Design JWT multi-project strategy

### Sprint 1: Schema + Contracts (1 week)
1. Add all Phase 2 Prisma models + migration
2. Add all Phase 2 types to packages/schemas
3. Add audit emitter service skeleton
4. Add Zod validation for all new types

### Sprint 2: Audit Trail + Project/Team CRUD (2 weeks)
1. Audit emitter + emit from existing mutations
2. Audit query endpoints
3. Project/team CRUD endpoints
4. Channel privacy enforcement in queries
5. Membership management endpoints

### Sprint 3: Token Ledger (2 weeks)
1. Worker token event emission
2. Ingestion + summary endpoints
3. Pricing profile management
4. Monthly estimate endpoint
5. Admin UI dashboard

### Sprint 4: Approval Gating (2 weeks)
1. Approval CRUD endpoints
2. Worker pause/resume flow
3. Continuation token mechanism
4. Expiry sweep
5. WebSocket events
6. Admin UI approval inbox

### Sprint 5: Policy + Discovery (1 week)
1. Policy evaluation middleware
2. Access check endpoint
3. Scoped search endpoints
4. Visibility enforcement at query time

### Sprint 6: GCP Deployment (2 weeks)
1. Terraform infrastructure
2. Pub/Sub adapter
3. GCS adapter
4. Dockerfiles + nginx.conf
5. Cloud Build pipeline
6. Hosted deployment test

### Sprint 7: Frontend + Review (2 weeks)
1. All new facades, pages, components
2. Settings page refactor
3. End-to-end testing
4. Review passes (Claude, Codex, max, Gemini)
5. Resolve verified findings

**Estimated total: 12-13 weeks**

---

## 10) What to Defer to Phase 3+

These items appear in specs but exceed Phase 2 "beta for teams" scope:

- Step-up verification (email/TOTP)
- Remote workers and policy intersection
- Secrets system
- Translation and multilingual delivery
- Tool import/registry/marketplace
- Project safety modes (preflight/degrade/restore/archive)
- Effective policy preview and explainability
- Bulk user import/invitation workflows
- Budget alerts and cost enforcement
- Advanced audit analytics and export

---

## 11) Spec Updates Required

### audit-trail-spec.md:
- Add `policySource` field to AuditLog model
- Add `correlationId` field
- Add `evidence` JSON field (or document it goes in metadata)
- Add index on `(organizationId, outcome, createdAt)`
- Clarify TaskEvent vs AuditLog relationship
- Add organization.updated to Phase 2 audited actions

### approval-gating-spec.md:
- Fix RunStatus reference (add `waiting_approval` to enum first)
- Add idempotency key for approval request creation
- Specify expiry sweep implementation (pgqueue topic)
- Document approval context schema per action type
- Document continuation token generation/verification mechanism

### token-ledger-spec.md:
- Fix `requestId` to be required (match ActionContext)
- Document `actorId` flattening from `actor.actorId`
- Add `/api/` prefix to all endpoint paths
- Add `project` to rollup dimensions in section 5
- Add pricing audit history endpoint

### phase2-gcp-deployment-spec.md:
- Add Redis/Memorystore section
- Clarify Cloud SQL connection method (connector, not Unix socket)
- Fix API service account to include GCS write
- Map logical Pub/Sub topics to physical topic names
- Add runner service phase clarification
- Revise cost estimate (add VPC connector, egress)
- Add Load Balancer health check and certificate config

### shared-type-contracts-spec.md:
- Add `waiting_approval` to RunStatus
- Add `approval.resolved` to WsEventMap

---

## 12) Cross-Links

- [implementation-phases.md](./implementation-phases.md)
- [approval-gating-spec.md](./approval-gating-spec.md)
- [audit-trail-spec.md](./audit-trail-spec.md)
- [phase2-gcp-deployment-spec.md](./phase2-gcp-deployment-spec.md)
- [token-ledger-spec.md](./token-ledger-spec.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [hosted-app-architecture.md](./hosted-app-architecture.md)
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
- [deployment-modes-and-auth-spec.md](./deployment-modes-and-auth-spec.md)
- [provider-system-and-frontend-architecture.md](./provider-system-and-frontend-architecture.md)
