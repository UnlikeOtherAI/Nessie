# Adversarial review — first-login workspace provisioning

Scope: `docs/plans/2026-08-31-first-login-workspace-provisioning.md`, checked against this Nessie worktree and the read-only UOA checkout at `/Volumes/External/Projects/UnlikeOtherAuthenticator` (`main` at `2d67bf0`). `Nessie:` and `UOA:` below identify the repository for each relative path. Section D is treated as completed data work; findings about it are consequences only.

Verdict: the UOA-authoritative shape is sound, but the plan is not safe to implement as written. A3 has no race-safe configurable enforcement mechanism, B2 is a backend-mode confused deputy, A1 is neither concurrent-idempotent nor applicable to the retained UOA accounts, and Part C omits identity-dependent write/notification paths and wire contracts.

1. **[blocker] A3 proposes returning to the exact check-then-write mechanism the existing migration proves is unsafe, and a request-time config JWT cannot drive a database constraint.**

   Evidence: `UOA:API/prisma/migrations/20260730180000_org_member_active_org_domain_constraint/migration.sql:11-18` records that a row trigger lost concurrent inserts at `READ COMMITTED`; `:303-338` replaces it with the partial unique index. The “existing locks” do not serialize a `(user, origin-domain)` set: `UOA:API/src/services/workspace-scope.service.ts:99-145` locks rows for one exact `orgId`, and locks nothing when that row does not yet exist. UOA migrations also run while the previous revision is serving (`UOA:Docs/deploy.md:28-35`), so globally dropping the index during revision startup exposes old code before the new policy code owns traffic.

   Remedy — Persist the domain policy server-side and enforce every ACTIVE transition under one canonical `(userId, originDomain)` advisory lock (with a staged old/new-revision-safe migration); do not ship A3 while the exact mechanism is an open question.

2. **[blocker] A3's write/read audit is far too small: several paths still encode “any membership on this domain means the one organisation,” and unscoped token context becomes nondeterministic.**

   Evidence: invitation creation suppresses a different-org invite at `UOA:API/src/services/team-invite.service.management.ts:109-133` and `UOA:API/src/services/team-invite.service.member.ts:154-170`; access-request admission rejects another org at `UOA:API/src/services/access-request.service.base.ts:205-230`; invite-link redemption does the same at `UOA:API/src/services/team-invite-link.service.ts:382-400`; member add/reactivation uses a domain-wide existence test at `UOA:API/src/services/organisation.service.members.ts:143-168`. Separately, `UOA:API/src/services/org-context.service.ts:69-81` uses unordered `findFirst`, and `UOA:API/src/services/token.service.ts:245-255` calls it when no exact active tuple was supplied.

   Remedy — Inventory every ACTIVE membership writer and every domain-wide `findFirst`; make policy checks count ACTIVE rows and require an exact org whenever more than one destination is legal.

3. **[blocker] B2's backend-mode relay is a confused deputy: sending an “acting subject” does not make UOA authorize that person.**

   Evidence: absence of `X-UOA-Access-Token` selects backend mode at `UOA:API/src/middleware/org-role-guard.ts:219-230`; that mode authenticates only the domain pairing and origin-domain org at `:115-183`. `UOA:API/src/routes/org/organisation-route.shared.ts:174-200` explicitly returns backend provenance with no acting user; `UOA:API/src/services/team.service.base.ts:282-317` treats an undefined actor as holding every capability. The team body has no subject field (`UOA:API/src/routes/org/team-route.shared.ts:39-43`), and the route passes only backend provenance (`UOA:API/src/routes/org/teams.ts:67-104`). Nessie's own relay documentation confirms that UOA performs no user role check and audits `actor_user_id: null` (`Nessie:packages/workspace-admin/src/uoa-org-roster.ts:38-52`). Invitation acceptance is not a generic precedent: it posts a subject to one exact invite (`Nessie:packages/workspace-admin/src/uoa-org-roster.ts:365-403`), and UOA verifies that invite's email against that user (`UOA:API/src/services/team-invite.service.acceptance.ts:90-100`).

   Remedy — Add a UOA user-delegated create endpoint that accepts the exact subject, re-reads ACTIVE membership plus `teams.manage`, and audits the human actor; never expose raw backend team creation as a person-facing Nessie action.

4. **[major] The proposed organisation picker contains display data, not the authorization facts B2 needs, and backend mode cannot operate on all organisations it displays.**

   Evidence: UOA directory rows contain a team role but no org role/capability verdict (`UOA:API/src/services/workspace-directory.service.ts:16-29,162-175`), while Nessie's parser discards even that role (`Nessie:api/src/services/uoa-workspace-directory.ts:70-95`). UOA's existing chooser computes the correct org-scope `teams.manage` set as `creatable_orgs` (`UOA:API/src/services/first-login.service.ts:468-481`). Backend mode additionally refuses an org whose origin is another product domain (`UOA:API/src/middleware/org-role-guard.ts:166-179`), although the directory can intentionally contain cross-product memberships (`UOA:API/src/services/workspace-directory.service.ts:69-72,111-138`).

   Remedy — Obtain a live server-computed `creatable_orgs`/capability verdict from UOA and use a user-delegated endpoint; do not infer authority from grouped directory entries.

5. **[major] The generic backend team-create route has a quota race that the hosted create flow already fixes.**

   Evidence: `UOA:API/src/services/team.service.teams.ts:153-172` performs `count < max_teams_per_org` and then inserts without locking the org; two backend calls can both pass. The hosted `/auth/create-team` path explicitly locks the org row for this reason at `UOA:API/src/routes/auth/auth-create-team.ts:165-173`. B2 chooses the former route while promising quota refusals.

   Remedy — Put the org-row lock inside the shared create transaction (or require every caller to acquire it) and add a concurrent cap-boundary database test.

6. **[blocker] A1 does not satisfy the plan's idempotent first-login invariant, and A3 removes the only constraint that currently rolls one loser back.**

   Evidence: `UOA:API/src/services/org-placement.service.ts:123-181` reads “no membership” and creates org/team/members with no advisory lock; `:188-195` converts every failure to `auto_create_failed`. The available per-user placement advisory lock is in another service (`UOA:API/src/services/user-team-requirement.service.ts:34-50`) and is not called here. The pending-invite check is outside the creation transaction (`UOA:API/src/services/org-placement.service.ts:398-416`), so an invite can be created after the check but before the personal org commits.

   Remedy — Run invite eligibility plus placement under the canonical per-user/domain lock, re-read after acquiring it, and return the winning exact tuple instead of swallowing the losing transaction.

7. **[major] Completed cleanup retained the very UOA accounts that A1 will never auto-provision.**

   Evidence: the plan records that UOA's 99 users remain (`Nessie:docs/plans/2026-08-31-first-login-workspace-provisioning.md:319-326`). Automatic placement is guarded by `createdUser` in both email verification (`UOA:API/src/services/auth-verify-email.service.ts:365-394`) and social login (`UOA:API/src/services/social/social-login.service.ts:186-227`). A returning retained account with zero memberships is therefore not an A1 “first login,” regardless of its first post-cleanup visit.

   Remedy — Add an explicit one-time zero-membership repair/onboarding path for retained users, or state and test that they must use the hosted manual creator; do not use a fresh-user acceptance test as production coverage.

8. **[major] “Filter the invite probe to ACTIVE” does not fix the tombstone bug; it merely moves the failure to the unique `(orgId,userId)` constraint.**

   Evidence: invite acceptance currently queries a domain membership and creates a row when absent (`UOA:API/src/services/team-invite.service.acceptance.ts:119-151`). `OrgMember` permanently retains one row per `(orgId,userId)` (`UOA:API/prisma/schema.prisma:1053-1075`). If a DEACTIVATED row exists in the target org, adding `status: ACTIVE` makes the query return none and the subsequent create collide; correct reactivation behavior already exists in `UOA:API/src/services/organisation.service.members.ts:143-210`.

   Remedy — Resolve the exact target tombstone separately and reactivate it atomically, while counting other ACTIVE origin-domain memberships under the A3 policy lock.

9. **[major] A4 cannot obtain pending invites for a zero-org user through the cited `/org/me` transaction because RLS intentionally hides them.**

   Evidence: `/org/me` sets `app.org_id` to null at `UOA:API/src/routes/org/me.ts:69-74` and currently returns before directory reads when no context exists at `:94-106`. The `team_invites_select` policy permits only `org_id = app.org_id` (`UOA:API/prisma/migrations/20260423000001_rls_enable_policies/migration.sql:192-211`), while the proposed existing helper queries invites by user email/domain (`UOA:API/src/services/workspace-directory.service.ts:185-213`). Moving that helper above the return would still yield zero rows.

   Remedy — Design a narrowly scoped verified-user invite lookup (admin transaction or SECURITY DEFINER predicate bound to user+domain); do not widen `team_invites` to a domain-wide user read.

10. **[major] A4 is not additive-compatible: it deliberately changes the meaning of `org` presence.**

    Evidence: the current contract omits `org` when `getUserOrgContext` returns null (`UOA:API/src/routes/org/me.ts:74-106,124-126`), and context itself means an ACTIVE org membership (`UOA:API/src/services/org-context.service.ts:66-83`). A consumer checking `if (response.org)` changes from false to true for an unprovisioned user; “the block is only added” is precisely the incompatible semantic change. Nessie's current parser is lenient and would survive (`Nessie:api/src/services/uoa-workspace-directory.ts:70-133`), but that does not prove other consumers safe.

    Remedy — Add a separate/versioned top-level `onboarding` block and preserve `org` as proof of real context until every consumer has migrated.

11. **[major] A2's universal literal team role `admin` violates UOA's configurable role vocabulary.**

    Evidence: only `owner` is mandatory; a domain may omit `admin` from `team_roles` (`UOA:API/src/services/config-org-features.schema.ts:69-79`), and UOA explicitly describes `admin` as non-reserved (`UOA:API/src/services/role-grants.ts:54-64`). The current differing writes are real—implicit default at `UOA:API/src/services/organisation.service.organisation.ts:187-207`, `owner` at `UOA:API/src/services/internal-admin.service.organisations.ts:131-135`, and configured/default placement at `UOA:API/src/services/org-placement.service.ts:164-177`—but replacing all of them with an invalid role is not unification.

    Remedy — Use structurally guaranteed `owner`, or add a validated per-domain creator-role setting; never hard-code optional `admin` across generic UOA creation services.

12. **[major] B1's named refusal cannot be implemented by renaming the existing exception, and its rollout is sequenced too late.**

    Evidence: one compound guard currently conflates wrong domain, wrong client, missing subject, invalid/missing token epoch, and missing org/team (`Nessie:api/src/services/uoa-session.ts:191-203`); all must not become `UOA_NO_WORKSPACE`. The plan then places all of Part B after A1/A3/A4, even though B1 is specifically the failure UX for feature-disabled/partial A rollout (`Nessie:docs/plans/2026-08-31-first-login-workspace-provisioning.md:193-205,328-337`).

    Remedy — Split a typed no-workspace error only after domain/client/sub/epoch verification, and deploy that classifier before or atomically with enabling A1 in Nessie's signed config.

13. **[major] B4 retires creation but leaves destructive/authoritative local project mutations open, and B5 heals only half of the workspace name mirror.**

    Evidence: `PATCH /api/projects/:projectId` can rename the UOA-backed workspace's Project and `DELETE` can remove it (`Nessie:api/src/routes/projects.ts:181-250,252-292`); the admin exposes Edit/Delete (`Nessie:admin/src/layouts/admin-shell/ProjectsSidebarNav.tsx:184-206`). Both lack the mode gate used only on membership routes. Materialization gives the paired Project and Team the same placeholder name (`Nessie:api/src/services/workspace-target.ts:72-105`), while the plan proposes healing only `Team.name`; the UI widely renders `Project.name`, including `Nessie:admin/src/layouts/admin-shell/ProjectsSidebarNav.tsx:124-151`.

    Remedy — Gate local create/rename/delete of the UOA structural name/container (while preserving genuinely Nessie-owned avatar/board settings) and heal paired Project+Team names atomically from UOA.

14. **[major] C2 is internally contradictory for local/password and generic OIDC users, and the proposed email-index change would break their identity key.**

    Evidence: `User.email` and `displayName` are non-null today specifically because `uoaSub` is null for local/password and generic OIDC principals (`Nessie:api/prisma/schema.prisma:876-900`). Generic OIDC resolves/creates by email and persists display name (`Nessie:api/src/services/workspace-principal.ts:75-88`); local authentication uses a unique email lookup (`Nessie:api/src/services/users.ts:354-361`, `Nessie:api/src/routes/auth-login.ts:427-446`), and local user creation requires both fields (`Nessie:api/src/services/users.ts:218-277`). C2 says both “drop users.email” and “keep nullable email,” while C1 supplies no analogous local-only disposition for display name.

    Remedy — Make UOA-owned fields null only when `uoaSub IS NOT NULL`, retain a unique non-null local email and local display name (or move both to a local-principal table), and clear them atomically on UOA adoption.

15. **[major] The profile-directory inventory misses required wire contracts, database sorting, and synchronous mention resolution; degraded `Member` is unsafe in those paths.**

    Evidence: `/api/auth/me` still requires email/displayName (`Nessie:api/src/services/auth.ts:292-303`; schema `Nessie:packages/schemas/src/identity.ts:118-128`), the member contract requires both (`Nessie:api/src/contracts/users-presence.ts:229-246`), and project members read them directly (`Nessie:api/src/routes/projects.ts:110-133`). Task assignee listing sorts in SQL by `displayName` (`Nessie:api/src/services/tasks.ts:43-58`). More seriously, message creation resolves `@name` from database display names before the write (`Nessie:api/src/services/message-create.ts:94-139`; matcher `Nessie:packages/runtime/src/user-alerts.ts:25-49`). A cold cache cannot be handled as render-only degradation: a missing name silently drops an alert, while giving several people the fallback `Member` makes one token match several users.

    Remedy — Inventory every query/contract and batch-hydrate profiles at each boundary; never feed degraded labels into mentions, recipient selection, sorting, authorization, or durable identifiers.

16. **[major] Putting a Map implementation in a shared package does not share profile state with the worker, and several worker consumers have no run-time roster read to prime it.**

    Evidence: the existing cache explicitly says each process/replica has its own state (`Nessie:api/src/services/uoa-directory-cache.ts:20-23,41-78`). Push dispatch reads an author name directly from Prisma (`Nessie:worker/src/control/push-dispatch.ts:127-170`), attention/call notifications do likewise (`Nessie:worker/src/control/attention-dispatch.ts:61-98`; `Nessie:worker/src/control/call-lifecycle.ts:25-59`), and DM creation persists the selected display name into `Channel.label` (`Nessie:worker/src/run/pa-tools/message-destination.ts:108-140`). These poller/control paths are not necessarily preceded by the plan's “run org roster read.”

    Remedy — Give every off-request worker path an explicit org-scoped batch resolver and safe fallback semantics, or retain a local-only snapshot for the exact durable product datum; do not describe a shared package as a shared cache.

17. **[minor] Part C does not actually end profile mirrors, and `pronouns` is not code-unused.**

    Evidence: `avatarUrl` is documented and synchronized as the same UOA profile mirror as `displayName` (`Nessie:api/prisma/schema.prisma:885-900`; `Nessie:api/src/services/uoa-profile-mirror.ts:3-20,30-60`) but C only drops display name/email. `pronouns` is returned by `/api/auth/me` (`Nessie:api/src/services/auth.ts:292-303`) and is in the public schema (`Nessie:packages/schemas/src/identity.ts:118-128`), so dropping it is a contract change even if no current UI renders it.

    Remedy — Include UOA-row `avatar_url` in the same transition, and update/remove the pronouns contract and local create inputs rather than calling the column unused.

18. **[major] The plan overlooks the simplest safe product model: a “workspace” is a UOA team; a new UOA organisation is a new Nessie tenant, not just another folder.**

    Evidence: Nessie's governing invariant maps one UOA org to one local `Organization` and one UOA workspace to one `Team` (`Nessie:docs/brief.md:22-31`); budgets, policies, audit, directory, and settings scope per organisation (`Nessie:AGENTS.md:140-143`). Therefore “New organisation…” grants a fresh tenant/owner boundary and is the only reason A3's risky invariant relaxation exists. Creating another team in the existing org already satisfies ordinary workspace creation through the hosted flow.

    Remedy — Default “Create workspace” to a team in an authorized existing org and reserve new-org creation for an explicit “create a new tenant” action; if separate tenants are truly required, state that entitlement and billing/policy consequence explicitly.

19. **[minor] B5's “nothing reads them” is true only for semantic in-repo consumers; the account metadata is still returned over the API.**

    Evidence: no code was found interpreting `metadata.teamIds`, `teamRoles`, `orgRole`, or `workspaceDirectory`, but `Nessie:api/src/services/integration-product-rows.ts:114-130` maps the entire account metadata object into `IntegratedProductResponse`. Unknown external/admin consumers therefore remain a contract risk even though the internal purge is correct.

    Remedy — Treat the keys as deprecated public metadata, verify consumers/telemetry, then strip them with a documented contract change.

20. **[minor] A1's default organisation name can publish email-derived PII.**

    Evidence: `UOA:API/src/services/org-placement.service.ts:87-90,116-122` falls back from absent `user.name` to the email local part and appends “'s organisation”; that name is then exposed through workspace directory org names (`UOA:API/src/services/workspace-directory.service.ts:162-175`).

    Remedy — Use a neutral default for unnamed users or require an explicit name before sharing the org with anyone else.

## Sections that survived the attack

- **Current-state citation audit:** the hosted first-workspace/team routes and their role differences, dormant feature flags, backend orphan-team behavior, partial unique index, zero-org `/org/me` shape, Nessie zero-workspace refusal, and exact-tuple materialization locks all match the cited code, subject to the findings above.
- **B3 materialization reuse:** survives. `Nessie:api/src/services/workspace-context.ts:286-325`, `external-organization.ts:28-40`, and `workspace-target.ts:52-70,112-162` are the existing 1:1, lock-protected path and should remain the only local materializer.
- **B5 metadata purge:** survives as an internal cleanup; no semantic in-repo reader was found, subject to finding 19's exposed-metadata caveat.
- **A5 admin deletion:** survives at UOA `2d67bf0`. The route is superuser-gated and supplies explicit admin provenance (`UOA:API/src/routes/internal/admin/organisations.ts:60-65,98-105`); the service translates protected-record foreign keys to `ORG_HAS_PROTECTED_RECORDS` and writes a surviving audit event (`UOA:API/src/services/organisation.service.organisation.ts:326-387`); the machine contract is present (`UOA:API/src/routes/root/schema.internal-admin.ts:334-345`).
- **Disclosure/tenant materialization:** survives if B3 is retained; no new disclosure bypass was found in the existing switch materializer. The B2 confused-deputy issue occurs upstream at UOA authorization, before disclosure provenance can help.
- **Section D:** not re-litigated. Its unanticipated consequences are findings 7 (retained users do not trigger first-user placement), 13 (all fresh workspace names make complete healing load-bearing), and 20 (email-derived default names).
