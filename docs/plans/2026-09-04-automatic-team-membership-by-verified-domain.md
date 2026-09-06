# Automatic team access after sign-in, by DNS-verified email domain

**Status:** Implemented (2026-09-05), behind `NESSIE_AUTOMATIC_MEMBERSHIP_ENABLED`
(default off). Revision 2 after plan review; §18 records what the code does
differently from this document after the code review.
**Supersedes:** `docs/plans/2026-08-20-nessie-corporate-domain-auto-enrolment-surface.md`
(it waited on UOA endpoints that were never shipped; none of it exists in code).
**Owning surfaces:** Organization → Members and Team → Members — an **Automatic
logins** tab on each, drawn by one shared component.

Revision 2 reverses revision 1's central mistake. Revision 1 proposed relaying
grants in UOA "backend mode" (domain-hash bearer, no acting user). Review
established that `POST /api/team/members` (`api/src/routes/team-members.ts:180-212`)
has **no local admin gate at all** — its entire authorization is
`withUoaRosterSubjectAssertion`, which UOA re-verifies against live membership
(the "`admin` picks the gate" comment at `:172` is stale; the `relay` helper has
no `admin` option). Backend mode would therefore have *removed* the only
authorization check this action has, and rebuilt a weaker one on the local
`TeamMember.role` projection that `docs/plans/2026-09-02-uoa-as-a-service-unification.md`
is trying to demote to a cache. Every grant in revision 2 carries a principal.

## 1. Outcome and terminology

An administrator proves the organisation controls an email domain, then names
the teams people from that domain should land in. When such a person signs in,
they are added to those teams as an ordinary **member**.

The UI never implies a domain authenticates anybody. UOA authenticates; the
domain only decides *where an already-authenticated person lands*.

| Element | Copy |
|---|---|
| Tab label | **Automatic logins** |
| Panel title | **Automatic team access after sign-in** |
| Panel lede | "When someone signs in with an email address at a domain you control, add them to these teams as a member. Sign-in always verifies who someone is — a domain never signs anyone in." |
| Domain state | Pending DNS · Verified · Active · Suspended · Revoked |
| Rule health | Active · Needs re-authorization |
| Confirm step | "Add existing matching people to *Team* now?" |

Never used: "auto-login", "domain login", "trusted domain", "SSO domain",
"domain authentication".

## 2. What is true today

Established by reading code, not assumed.

**C1 — UOA is the sole authority for team membership.** `docs/brief.md` →
"Current SSO identity invariant" and `docs/standards/team-model.md` say so, and
the code matches: `api/src/routes/team-members.ts` persists nothing and relays
to `addTeamMember`. Local `TeamMember` rows are written only by
`ensureTeamMemberships` (`api/src/services/team-principal.ts:133`), only from
claims UOA returned. *So an automatic grant is a relay, never a local write.*

**C2 — every UOA-relayed membership write is authorized upstream, by a live
principal.** `withUoaRosterSubjectAssertion` /
`withUoaOrgRosterSubjectAssertion` mint a 60-second RS256
`X-UOA-Subject-Assertion` naming a subject and token version; UOA re-resolves
that subject's live role. `packages/team-admin/src/uoa-org-roster.ts:47-48`:
*"A missing or mismatched UOA session is an error, never a fallback to
tenant-wide backend mode."* *So this feature must carry an assertion too.*

**C3 — UOA does not assert `email_verified`.**
`resolveUoaIdentityFromAccessToken` (`api/src/services/uoa-session.ts:141-166`)
parses `sub`, `email`, `name`, `preferred_username`, `tv`, `org.*`, `active.*`
and nothing else. The only `email_verified` reads in the repo are
`api/src/services/external-auth.ts:212` (generic OIDC) and
`packages/comms-google/src/identity.ts:114`. §4.1 is what this forces.

**C4 — UOA has no "identities matching a domain" query, but it does have a
per-subject membership read.** `listOrganisationMembers(orgId, query, deps)` is
cursor-paged and returns `uoaSub`, `email`, `orgRole`, `status`;
`listOrganisationMemberWorkspaceAccess(orgId, uoaSub, deps)`
(`packages/team-admin/src/uoa-org-members.ts:193`) returns every team in the org
with a per-team `hasAccess` boolean for one person. The second is the pre-read
that makes §4.4 possible without a roster scan.

**C5 — only existing UOA organisation members can reach this tenant.** Sign-in
requires a UOA token whose `active.orgId` maps to this
`Organization.externalOrgId`. A domain rule therefore places an existing
organisation member into teams *inside the organisation they are already in*;
it cannot admit a stranger to the organisation. This is a team-placement
feature, not an admission feature.

## 3. Relationship to the superseded plan

Kept: UOA owns identity and membership; no local identity copies; the UOA
subject is the only person key; fail-closed errors; no surface for
local/no-IdP installs.

Reversed: the 2026-08-20 plan made Nessie a pure relay of a *UOA-owned* domain
claim, gated on a `corporate_domain_auto_enrolment_management` signed-config
flag and an `X-UOA-Management-Assertion`. UOA shipped none of it and there is no
date. This plan holds the **policy** in Nessie (which domain, which teams, DNS
proof, audit, reconciliation) and leaves the **membership** and its
**authorization** in UOA. Mark the old plan superseded in the same commit; do
not delete it.

## 4. Decisions

### 4.1 The trust basis for an email address

C3 means "a currently verified email asserted by UOA" has no field behind it.
Revision 1 proposed requiring a claim UOA never sends, plus a default-off
"trust the email anyway" flag — review correctly called that a flag whose only
useful position is on, i.e. the permissive option wearing a fail-closed label.

Revision 2 names the real trust basis instead, and it is one this codebase
already relies on:

> An automatic grant may target only a person who is **already an ACTIVE member
> of this UOA organisation**, and it grants no more than an organisation admin
> already grants by hand.

That is exactly the existing manual path. `MembersRosterPanel` → "Add member"
shows the admin a candidate list of active organisation members with their
email addresses (`findTeamMemberCandidates`), and the admin picks one *by
reading the email*. `PUT /api/organization/members/:uoaSub/workspaces` then adds
them to teams. This feature applies a written rule where a human applies a
click; the identity evidence is identical, and UOA's organisation join policy —
not Nessie — is what vouches for the address in both cases.

Concretely:
- Grant targets are filtered on UOA's `status === 'ACTIVE'` in the organisation.
- Sign-in targets satisfy this structurally (C5).
- If UOA ever sends `email_verified`, parse it into
  `ExternalAuthIdentity.emailVerified?: boolean` and refuse on an explicit
  `false` — the same rule the generic-OIDC branch already applies. Absent
  stays permitted, exactly as at `external-auth.ts:212`.
- No "trust" flag exists. There is nothing to turn on.

The limit is stated in the panel, in the docs and here: **if UOA's organisation
join policy lets someone join with an address they do not own, this feature
places them by that address.** That risk belongs to the join policy and is
identical for the manual button. Step 1 of §15 verifies the deployment's join
policy before the feature is enabled; if it turns out to be self-serve, the
feature must not ship until UOA asserts `email_verified`.

### 4.2 Every grant carries a principal, re-verified by UOA

A rule records **who authorized it**: `authorizedByUoaSub` and
`authorizedTokenVersion`, captured from the live session of the admin who
created or last re-authorized it. Every grant made by that rule — at sign-in and
during reconciliation alike — mints a fresh org-scoped assertion for that
subject via `createUoaSubjectAssertion`
(`packages/runtime/src/uoa-delegated-identity.ts:301`) and calls UOA with it.

This is the single most important property of the design: **UOA re-resolves the
authorizer's live organisation membership and role on every single call.** A
demoted, deactivated or removed admin's rule stops granting immediately,
upstream, without Nessie noticing first. It is what makes "re-check
authorization before every batch" a mechanism rather than a claim, and it is
strictly stronger than any local check Nessie could write.

The same property settles the team surface. A team-authored rule stores the
team admin's subject, so UOA refuses a write to any team that admin does not
administer. Nessie's local gate and UOA's gate then agree by construction,
instead of Nessie's replacing UOA's.

Backend mode (no acting user) is used **nowhere** in this feature.

### 4.3 Authorization loss is a health transition, not a silent stall

An assertion that stops verifying is exactly the failure
`docs/standards/capability-health-alerts.md` was written after, so this feature
follows that standard rather than inventing a second mechanism:

- A `401`/`403` `UoaRosterRejectedError` on a grant moves the rule to
  `healthState: 'needs_reauthorization'` and persists the upstream reason.
- Alert exactly once per transition, via `healthRevision` plus the existing
  `user_alerts (user_id, event_key)` uniqueness. No second marker table, no
  email sender.
- Recovery is **explicit**: `POST .../rules/:id/reauthorize` re-captures the
  calling admin's live subject and token version, after re-running the same
  permission gate as creation. Re-stamp the identity and the revision only.
- **Never auto-heal at login.** The standard is explicit about why: signing in
  proves the same person is present, not that they intend a dormant automation
  to resume.
- The panel renders the state as a **Re-authorize** button (a state that names
  its remedy), never a bare `error`.

`notificationEmail` from revision 1 is deleted. It stored an email address the
plan claimed not to store, and it was a second alerting mechanism beside the
one the standard mandates. The optional notification contact the requirement
asks for is served by that alert, which already reaches the right people and
confers no authority.

### 4.4 Never send a role; always pre-read membership

`addTeamMember` sends `team_role` whenever it is passed
(`packages/team-admin/src/uoa-org-roster-pages.ts:106-118`), and
`docs/plans/2026-09-02-uoa-as-a-service-unification.md` §4.5 records that UOA's
add is becoming an **upsert** — so passing `teamRole: 'member'` would silently
demote an existing team owner. The one existing programmatic caller does the
opposite and is the precedent to copy (`api/src/routes/organization-members.ts:358-368`):
read `hasAccess` first, then call with **no role**.

So the grant helper is:

```ts
const access = await listOrganisationMemberWorkspaceAccess(orgId, uoaSub, assertionDeps)
const target = access.items.find((w) => w.id === externalTeamId)
if (!target) return 'skipped_no_such_team'
if (target.hasAccess) return 'skipped_existing'
await addTeamMember({ externalOrgId, externalTeamId }, { uoaSub }, assertionDeps)  // no teamRole
return 'granted'
```

The request body of every route in §12 has no role field, so there is nothing
for a caller to escalate. Stronger existing roles are preserved because the
grant is skipped entirely when the person is already on the team, and because
no call ever names a role.

### 4.5 Rules are additive only

Narrowing, suspending, revoking, losing DNS or losing authorization stops
**future** grants and nothing else. No code path in this feature removes a
membership or changes a role — the grant helper's only mutation is
`addTeamMember`. Removal stays the explicit existing action.

### 4.6 Permission boundary

- **A domain claim** (create, verify, rotate, suspend, revoke) is
  **organisation owner/admin only**, via the existing
  `resolveOrganizationAdministrationAccess`
  (`api/src/services/uoa-organization-administration.ts:55`). A verified domain
  takes an instance-wide exclusivity lock (§5), so claiming one is an
  organisation-level act; a team admin must not take it.
- **A grant rule** — "this domain also grants team T" — is managed by
  organisation owners/admins for any team in the org, and by team owners/admins
  for their own team only. The local check resolves the caller's role on that
  team through `team.project.organizationId` (Team has no `organizationId`), and
  UOA independently refuses a write the authorizer may not make (§4.2).

## 5. Data model

Three tables, one additive migration
(`api/prisma/migrations/20260904HHMMSS_automatic_membership_rules/`). No
existing table changes shape. No email, display name or avatar is stored
anywhere in this feature; the only person identifier persisted is `uoaSub`.

```prisma
enum AutomaticMembershipDomainStatus {
  pending      // claimed, challenge issued, DNS not yet proven
  verified     // DNS proven twice, not yet switched on
  active       // proven and provisioning enabled
  suspended    // paused by an admin, by the kill switch, or by failed revalidation
  revoked      // released; frees the instance-wide lock and can be re-claimed
}

model AutomaticMembershipDomain {
  id                 String   @id @default(uuid()) @db.Uuid
  organizationId     String   @map("organization_id") @db.Uuid
  /** Normalised: lowercase, punycode/ASCII, no trailing dot. Exact match only.
   *  Every DNS lookup and every match is built from THIS value, never from raw
   *  admin input, so UTS-46 folding cannot create a check-vs-use mismatch. */
  domain             String
  status             AutomaticMembershipDomainStatus @default(pending)
  /** 32 random bytes, unpadded base32. Published in DNS, so not secret at rest,
   *  but never audited, never logged, never placed in a URL. */
  challenge          String
  challengeIssuedAt  DateTime  @map("challenge_issued_at")
  challengeExpiresAt DateTime  @map("challenge_expires_at")
  /** Two independent successful observations are required before `verified`. */
  firstSeenAt        DateTime? @map("first_seen_at")
  verifiedAt         DateTime? @map("verified_at")
  lastCheckedAt      DateTime? @map("last_checked_at")
  lastCheckOutcome   String?   @map("last_check_outcome")
  lastCheckDetail    String?   @map("last_check_detail")
  revalidationFailures Int     @default(0) @map("revalidation_failures")
  createdByUserId    String?   @map("created_by_user_id") @db.Uuid
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  rules        AutomaticMembershipRule[]
  reconciliations AutomaticMembershipReconciliation[]

  @@index([organizationId])
  @@index([status, lastCheckedAt])
  @@map("automatic_membership_domains")
}
```

**No `@@unique([organizationId, domain])`** — revision 1 had one, and it made
revocation terminal: an organisation could never re-claim a domain it released.
Uniqueness is instead a partial index, in raw SQL because Prisma cannot express
it:

```sql
-- Instance-wide exclusivity: a live claim on a domain belongs to one
-- organisation. `pending` is excluded so two organisations may both attempt a
-- claim and the first to prove DNS wins; `revoked` is excluded so releasing a
-- domain frees it and the same organisation can claim it again later.
CREATE UNIQUE INDEX automatic_membership_domains_live_claim_key
  ON automatic_membership_domains (domain)
  WHERE status IN ('verified', 'active', 'suspended');

-- One live claim per organisation per domain, same predicate.
CREATE UNIQUE INDEX automatic_membership_domains_org_live_claim_key
  ON automatic_membership_domains (organization_id, domain)
  WHERE status IN ('pending', 'verified', 'active', 'suspended');
```

The second-place organisation's verification fails with
`AUTOMATIC_MEMBERSHIP_DOMAIN_CLAIMED` and is told to use manual invitations
until the claim is released. The message names no other organisation.

```prisma
model AutomaticMembershipRule {
  id       String @id @default(uuid()) @db.Uuid
  domainId String @map("domain_id") @db.Uuid
  teamId   String @map("team_id") @db.Uuid
  /** Which surface authored it. Presentation and audit only; the permission
   *  check is always re-derived from the caller, never read from this. */
  createdScope String @map("created_scope")   // 'organization' | 'team'
  enabled      Boolean @default(true)

  /** §4.2. The principal every grant from this rule acts as. UOA re-resolves
   *  this subject's live role on every call, which is the authorization. */
  authorizedByUoaSub      String  @map("authorized_by_uoa_sub")
  authorizedTokenVersion  Int     @map("authorized_token_version")
  authorizedAt            DateTime @map("authorized_at")
  /** §4.3, per docs/standards/capability-health-alerts.md. */
  healthState    String @default("ok") @map("health_state")  // 'ok' | 'needs_reauthorization'
  healthReason   String? @map("health_reason")
  healthRevision Int     @default(0) @map("health_revision")

  createdByUserId String?  @map("created_by_user_id") @db.Uuid
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  domain AutomaticMembershipDomain @relation(fields: [domainId], references: [id], onDelete: Cascade)
  team   Team                      @relation(fields: [teamId], references: [id], onDelete: Cascade)
  grants AutomaticMembershipGrant[]

  @@unique([domainId, teamId])
  @@index([teamId])
  @@map("automatic_membership_rules")
}

/** The idempotency ledger: one row per (rule, person). This — not the queue —
 *  is what makes retries, duplicate sign-ins, overlapping rules and concurrent
 *  logins free. Written before the upstream call and committed regardless of
 *  its result, so a crash mid-call cannot double-grant (§8). */
model AutomaticMembershipGrant {
  id        String   @id @default(uuid()) @db.Uuid
  ruleId    String   @map("rule_id") @db.Uuid
  uoaSub    String   @map("uoa_sub")
  /** attempted | granted | skipped_existing | skipped_no_such_team | failed */
  outcome   String   @default("attempted")
  source    String                       // 'signin' | 'reconcile'
  /** Lease for the in-flight upstream call; a stale `attempted` row past this
   *  is retryable, a fresh one means another worker owns it. */
  leaseExpiresAt DateTime? @map("lease_expires_at")
  failureReason  String?   @map("failure_reason")
  attempts   Int      @default(0)
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  rule AutomaticMembershipRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)

  @@unique([ruleId, uoaSub])
  @@map("automatic_membership_grants")
}

model AutomaticMembershipReconciliation {
  id       String @id @default(uuid()) @db.Uuid
  domainId String @map("domain_id") @db.Uuid
  ruleIds  String[] @map("rule_ids")
  /** queued | running | completed | failed | superseded | cancelled */
  status   String  @default("queued")
  cursor   String?
  scanned  Int @default(0)
  matched  Int @default(0)
  granted  Int @default(0)
  skipped  Int @default(0)
  failed   Int @default(0)
  lastError String? @map("last_error")
  startedAt  DateTime? @map("started_at")
  finishedAt DateTime? @map("finished_at")
  requestedByUserId String? @map("requested_by_user_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  domain AutomaticMembershipDomain @relation(fields: [domainId], references: [id], onDelete: Cascade)

  @@index([domainId, status])
  @@map("automatic_membership_reconciliations")
}
```

## 6. Domain normalisation and classification

Revision 1 proposed a new package, three new runtime dependencies, two
vendored+checksummed community lists, a refresh script and a lint verifier.
Review was right that this is over-engineering under `AGENTS.md` → Code
Quality: **nobody passes a DNS TXT check for `gmail.com`**, so the blocklist
adds almost nothing on top of the proof that actually gates the feature. It is
kept because the requirement asks for it, but reduced to its useful core.

One module, `packages/schemas/src/email-domain.ts` (pure, no I/O, imported by
api and worker alike — the existing home for shared contracts):

```ts
export type DomainRejection =
  | 'malformed' | 'ip_literal' | 'localhost' | 'public_suffix'
  | 'single_label' | 'too_long' | 'consumer_provider'
export type DomainDecision =
  | { ok: true; domain: string } | { ok: false; reason: DomainRejection }

export const normaliseDomain = (input: string): DomainDecision
export const classifyEmailDomain = (domain: string): DomainDecision
export const domainOfEmail = (email: string): string | null
```

Normalisation, in order: trim; strip one trailing dot; reject whitespace, `@`,
`/`, `:`; lowercase; IDNA-to-ASCII via `domainToASCII` from `node:url` (empty →
`malformed`); reject IPv4/IPv6 literals including bracketed forms; reject
`localhost`, `*.localhost`, `*.local`; reject a single label; reject total
length > 253 or any label > 63.

Classification adds two checks:
- **Public suffix** — one new dependency, `tldts` (MIT, 7.4.x, weekly PSL
  refresh, ICANN section by default). Reject when the domain *is* a public
  suffix or has no registrable domain: `co.uk` and `github.io` are rejected,
  `example.co.uk` is fine.
- **Consumer providers** — an explicit, hand-maintained list in the same file,
  one line per entry, covering Gmail/googlemail, Outlook/Hotmail/Live/MSN,
  Yahoo/ymail/rocketmail, iCloud/me.com/mac.com, Proton/protonmail/pm.me, GMX,
  AOL, Yandex, Mail.ru, Zoho, Fastmail and the like. It is in the diff, so it is
  auditable, which is what "auditable denylist" asks for. No community list is
  vendored and no refresh script is added; a missing entry is a one-line PR and
  DNS proof is the control that actually holds.

Disposable-provider blocking falls out of the same list plus the public-suffix
rule for the throwaway providers that matter; a dedicated disposable feed is
explicitly **not** shipped, because a disposable provider that passes a TXT
check on its own apex is a provider the claimant genuinely controls, which no
list can decide for us.

The residual risk the requirement's blocklist does *not* cover is named in the
panel and the docs: a domain the claimant genuinely controls that hosts
third-party mailboxes (`alumni.university.edu`, a hosting provider's customer
domain). The mitigation is the org-owner confirmation step in §13 that names
the domain and the teams before activation, and exact-match-only.

Classification runs at claim time and again before every grant, so a list update
stops provisioning at the next grant and the panel shows the reason.

## 7. DNS verification lifecycle

**Record.** TXT at `_nessie-domain-verification.<domain>` (host-level, so it
cannot collide with SPF/DMARC), value `nessie-domain-verification=<challenge>`,
challenge = 32 bytes of `crypto.randomBytes` in unpadded base32. The lookup name
is built from the **stored ASCII domain**, never from raw input.

**Resolver seam.** `resolveTxt` from `node:dns/promises` behind
`DomainVerificationDns = { txt: (name: string) => Promise<string[][]> }` — the
injectable-seam shape `packages/agent-mail/src/mailbox-discovery.ts` already
uses. Chunked records are joined per RFC 1035 before comparison; a plain string
compare (the value is published in DNS — `timingSafeEqual` on a public value is
cargo cult, and throws `RangeError` on unequal lengths); a domain passes if
**any** record at the name matches. The resolver's answer count and outcome go
into `lastCheckDetail` for the audit trail.

**Two observations.** A single successful lookup sets `firstSeenAt`. `verified`
requires a second success at least 10 minutes later, so one spoofed or poisoned
answer cannot mint a claim that takes the instance-wide lock.

| From | Event | To |
|---|---|---|
| — | admin claims domain | `pending` (challenge, 7-day expiry) |
| `pending` | first check passes | `pending` + `firstSeenAt` |
| `pending` | second check ≥10 min later, lock free | `verified` |
| `pending` | check passes, lock taken | `pending`, error `DOMAIN_CLAIMED` |
| any | admin rotates challenge | `pending` (new challenge, `firstSeenAt` cleared) |
| `verified` | admin activates (confirm dialog) | `active` + reconciliation enqueued |
| `active` | admin suspends, or kill switch off | `suspended` |
| `active` | 3 consecutive revalidation failures | `suspended` |
| `suspended` | revalidation passes and admin resumes | `active` |
| any | admin revokes | `revoked` (lock released; rules retained, inert) |
| `revoked` | admin re-claims | `pending` (new challenge) |

**Revalidation cadence.** Revision 1 proposed a 12-hour `setInterval`, which in
a deployment that redeploys more than twice a day would never fire — every
existing sweep in `worker/src/index.ts` ticks in seconds to minutes for exactly
this reason, and the one long-cadence job (`maybeSyncRegistry`) uses a **short
tick that asks whether one is due**. This follows that: a 5-minute tick queries
`[status, lastCheckedAt]` for domains due (24 h since last check) and enqueues
one `automatic-membership.revalidate` job each, with a window-bucketed
idempotency key `auto-membership:revalidate:${domainId}:${bucket}` so N replicas
enqueue one job per window. Three consecutive failures suspends; a success
resets. Suspension removes nobody.

## 8. Provisioning at sign-in

The match is computed **in the login path, in memory, from the email the token
just asserted** — so no email is persisted anywhere. `ensureTeamPrincipal`
(`api/src/services/team-principal.ts:226`) already runs one transaction, and
`enqueueQueueJob` takes a transaction client (it needs only `$executeRaw`), so
the enqueue is atomic with the principal write:

```ts
// inside the existing transaction, after ensureTeamMemberships
const ruleIds = await matchAutomaticMembershipRules(transaction, {
  organizationId, email, emailVerified,          // email stays in memory
})
if (ruleIds.length > 0) {
  await enqueueQueueJob(transaction, {
    topic: AUTOMATIC_MEMBERSHIP_PROVISION_TOPIC,
    payload: { organizationId, uoaSub, ruleIds },  // no email, ever
    idempotencyKey: `auto-membership:provision:${organizationId}:${uoaSub}:${minuteBucket}`,
  })
}
```

Two revision-1 defects fixed here:

- **No email in the payload.** `queue_jobs` rows are never deleted anywhere in
  this repo, so a payload email would be a permanent local copy of UOA identity
  data — forbidden by `docs/brief.md` and contradicting §5. The payload carries
  a subject and rule ids only.
- **The idempotency key can no longer burn permanently.** `queue_jobs` has a
  *full* unique index on `idempotency_key` (`api/prisma/schema.prisma:3937`) and
  `enqueueQueueJob` uses `ON CONFLICT DO NOTHING`, so revision 1's
  `rulesRevision` key meant one dead job disabled the feature for that person
  forever — and `max(updatedAt)` was also non-monotonic (deleting the most
  recently updated rule moves it *backwards* onto a burned key). The key is now
  a one-minute bucket: it collapses a burst of concurrent sign-ins, and the next
  sign-in always gets a fresh key. **Correctness never rests on the queue key**
  — the grant ledger is the idempotency mechanism.

Sign-in never waits for the grant and never fails because of it. New teams
appear in the person's team switcher on their next directory read.

**Handler.** For each rule id: re-read the rule and its domain and confirm
enabled, `active`, `healthState === 'ok'`, the classifier still passes, the
instance flag and the org kill switch are on. Then run the grant helper (§9).

## 9. The grant helper — one function, both callers

```
grant(rule, uoaSub, source):
  1. tx: upsert AutomaticMembershipGrant (ruleId, uoaSub)
       - row exists and outcome is terminal            -> return that outcome
       - row exists, 'attempted', lease still valid    -> return 'in_flight'
       - otherwise set outcome='attempted', attempts+=1,
         leaseExpiresAt = now + 2 min                  -> COMMIT
  2. mint a fresh org-scoped assertion for rule.authorizedByUoaSub
  3. listOrganisationMemberWorkspaceAccess -> hasAccess?  (§4.4)
  4. addTeamMember, no teamRole, if not already a member
  5. tx: write the final outcome, clear the lease
  6. on 401/403 -> rule healthState='needs_reauthorization' (§4.3)
     on 5xx/transport -> leave 'attempted' with the lease expired, retryable
```

Step 1 **commits before** the upstream call. Revision 1 held the transaction
open across a 10-second `rosterRequest`
(`packages/team-admin/src/uoa-org-request.ts:105`), which would have parked a
Prisma connection for up to `50 × rules × 10 s` per batch and — worse — made a
second worker **block on the unique index** for the duration of the first
worker's HTTP call rather than skipping, because an uncommitted insert does not
raise a conflict. The lease replaces that: an uncommitted row no longer exists,
a fresh `attempted` row means someone else owns it, and a stale one is
retryable.

Overlapping rules are naturally idempotent — two domains pointing at the same
team produce two rule rows and the second grant resolves `skipped_existing`.

## 10. Reconciliation (backfill)

Enqueued when a domain is activated and when a rule's team set changes. A new
`AutomaticMembershipReconciliation` row marks any `queued`/`running` run for the
same domain `superseded`; every batch re-reads its own row and stops if it is no
longer current.

Topic `automatic-membership.reconcile`, one job per batch, self-continuing — the
`executeCommsIncrementalSweepJob` shape (`worker/src/control/comms-sync.ts:336`):

```
per batch (limit 50):
  reload run row; stop if superseded or cancelled
  re-check instance flag, kill switch, domain 'active', rule set unchanged,
    classifier still passes, every rule healthState 'ok'
  mint a fresh assertion for the run's authorizing admin       <- the authorization
  listOrganisationMembers(externalOrgId, { cursor, limit: 50 }, assertionDeps)
  filter: status ACTIVE and domainOfEmail(email) === domain
  for each match x rule -> grant helper (§9), paced by the token bucket
  persist cursor + counters
  if meta.hasMore -> enqueue next batch (delayMs = BATCH_PAUSE_MS) else complete
```

**Authorization is re-checked per batch because the assertion is minted per
batch and UOA re-resolves it** — the mechanism §4.2 buys. A revoked admin's run
fails on its next batch and moves the rule to `needs_reauthorization`.

**Rate limiting.** Revision 1 claimed a 1-second inter-batch pause capped a
tenant at ~50 reads/second; that arithmetic ignored that a batch is 1 roster
read plus up to `50 × rules` **writes** issued back-to-back — a 150-request
burst with three rules. Revision 2 adds a token bucket in
`worker/src/control/automatic-membership/rate-limit.ts` shared across all runs
in the process (default 5 upstream calls/second per organisation, 20
instance-wide), applied to every call including the per-subject pre-read, plus
the 1-second inter-batch pause. At 50 k members and one 200-person domain that
is ~1000 batches; the run is designed to take hours and to be resumable, which
is why it is durable rather than interactive.

**Cursor stability.** UOA's keyset cursor is not guaranteed stable across an
hours-long run over a mutating roster, so skipped pages are possible by
construction. This is accepted and mitigated rather than hidden: reconciliation
is **repeatable and free to re-run** (the ledger makes a second pass grant
nobody twice), the panel offers "Run again", and a rejected cursor restarts the
run from the beginning rather than failing it.

**Retries.** `UoaRosterUnavailableError` re-enqueues the same batch with
`exponentialBackoffMs({ attempt, baseMs: 30_000, capMs: 30 * 60_000 })` from
`@nessie/runtime`, max 5, then `failed` with `lastError`. A 4xx fails the run
immediately — retrying a refusal is pointless.

**Cancellation is a real mechanism**, not a noun in an enum:
`DELETE /api/organization/automatic-membership/reconciliations/:id`, org-admin
gated, sets `cancelled`, emits
`organization.automatic_membership.reconcile_cancelled`, and is rendered as a
**Stop** button beside the progress counters.

**No broad list of people.** The run row holds counters and a cursor. §13
renders exactly those.

## 11. Feature flag and kill switch

- **Instance rollout flag** — `packages/config`:
  `automaticMembership.enabled` / `NESSIE_AUTOMATIC_MEMBERSHIP_ENABLED`,
  default `false`. Off ⇒ routes answer `404` and the tab is absent. (This adds
  three keys to a file already over the 500-line cap; splitting the config
  schema is a separate refactor and is not smuggled into this change.)
- **Per-organisation kill switch** — a `ScopedSetting` at organisation scope,
  key `automaticMembership.enabled`, through `resolveScopedSetting` /
  `writeScopedSetting`. `docs/standards/scoped-settings.md` calls a hand-rolled
  fifth cascade a defect, so this uses the sanctioned one.

Stated plainly rather than mislabelled: `resolveScopedSetting` returns
`{ value: null }` when no row exists, and **absent means enabled** — an
organisation that never touched the switch must not have to opt in twice. It is
therefore an emergency stop, not a fail-closed gate; the fail-closed gate is the
instance flag, which defaults off. The worker resolves it with
`{ organizationId }` **only**, so the team and user tiers of the cascade cannot
re-enable what an organisation turned off.

It ships with all three of the things revision 1 left out: a route
(`PUT /api/organization/automatic-membership/enabled`, org-admin), a control
(a `Switch` at the top of the panel with a confirm on disable), and an audit
action (`organization.automatic_membership.provisioning_toggled`). Turning it
off stops the sign-in handler and every reconciliation batch at their next
check; memberships, rules, ledger and audit are all preserved and nobody is
removed.

Both switches are re-read at the top of every job, never cached.

## 12. API surface

`api/src/routes/automatic-membership.ts`, registered in
`api/src/register-api-routes.ts`. Fastify, `parseInput`, `sendApiError`,
`createApiResponse`.

| Method | Path | Gate |
|---|---|---|
| `GET` | `/api/organization/automatic-membership` | org owner/admin |
| `PUT` | `.../automatic-membership/enabled` | org owner/admin |
| `POST` | `.../automatic-membership/domains` | org owner/admin |
| `POST` | `.../domains/:id/verify` | org owner/admin |
| `POST` | `.../domains/:id/rotate-challenge` | org owner/admin |
| `PATCH` | `.../domains/:id` (suspend / resume) | org owner/admin |
| `DELETE` | `.../domains/:id` (revoke) | org owner/admin |
| `PUT` | `.../domains/:id/teams` (checkbox set) | org owner/admin |
| `POST` | `.../rules/:id/reauthorize` | org owner/admin, or team owner/admin of that rule's team |
| `POST` | `.../domains/:id/reconciliations` | org owner/admin |
| `DELETE` | `.../reconciliations/:id` | org owner/admin |
| `GET` | `/api/team/automatic-membership` | **team owner/admin only** |
| `PUT` | `/api/team/automatic-membership/domains/:id` (attach/detach this team) | team owner/admin of this team |

The team `GET` is owner/admin-gated, not member-readable: revision 1 let any
team member enumerate the organisation's whole domain inventory, which fails
Rule zero check 3 — there is no decision a member makes with that list.

**The challenge is an org-admin-only field.** Both `GET`s return the same shape
so one panel renders both, and `challenge` is declared optional in that shape
and **stripped server-side** for every response that is not an org-admin read of
their own organisation. §14 carries an explicit negative test for it.

Error codes, fail-closed and non-enumerating:
`AUTOMATIC_MEMBERSHIP_DISABLED` (404), `ORGANIZATION_NOT_LINKED` (404),
`ORGANIZATION_ADMIN_REQUIRED` / `TEAM_ADMIN_REQUIRED` (403),
`AUTOMATIC_MEMBERSHIP_DOMAIN_REJECTED` (400, carries the `DomainRejection`),
`AUTOMATIC_MEMBERSHIP_DOMAIN_CLAIMED` (409),
`AUTOMATIC_MEMBERSHIP_DNS_UNVERIFIED` (409, carries `lastCheckDetail`),
`AUTOMATIC_MEMBERSHIP_NEEDS_REAUTHORIZATION` (409),
`UOA_ORGANIZATION_ACCESS_UNAVAILABLE` (503).

## 13. Audit

Fourteen actions appended to `AuditActionSchema`
(`packages/schemas/src/governance.ts:189`) — the closed enum, not the
raw-string escape hatch:

```
organization.automatic_membership.domain_created
organization.automatic_membership.dns_checked
organization.automatic_membership.domain_verified
organization.automatic_membership.domain_activated
organization.automatic_membership.domain_suspended
organization.automatic_membership.domain_revoked
organization.automatic_membership.challenge_rotated
organization.automatic_membership.rule_changed
organization.automatic_membership.rule_reauthorized
organization.automatic_membership.rule_needs_reauthorization
organization.automatic_membership.grant_issued
organization.automatic_membership.provisioning_toggled
organization.automatic_membership.reconcile_started
organization.automatic_membership.reconcile_finished
organization.automatic_membership.reconcile_cancelled
```

**Two mechanics revision 1 got wrong.** `emitAuditEvent` lives in
`api/src/services/audit.ts` and requires a full `AuthorizedActionContext`, and
the worker cannot import `api/src/services/*` — which is why the roster code
lives in a package at all
(`packages/team-admin/src/uoa-org-roster.ts:36-41`). Route-emitted events use
`emitAuditEvent`; **job-emitted events** (`dns_checked`, `grant_issued`,
`reconcile_*`, `rule_needs_reauthorization`) use `writeAuditEntry` from
`@nessie/db` — what `emitAuditEvent` wraps — with an explicit
`actorType: 'system'` and the authorizing admin recorded in metadata. And
`REDACTED_FIELDS` (`api/src/services/audit.ts:6-16`) does **not** contain
`challenge`, so revision 1's "already redacts" was false: add `challenge` to
that set in the same change, and never pass it in metadata regardless.

Metadata carries `domain`, `domainId`, `ruleId`, `teamId`, `uoaSub`, `source`,
`outcome` and reconciliation counters. Never the challenge, never an email.

## 14. UI

**One component, both surfaces — it already exists.** `MembersRosterPanel`
(`admin/src/pages/settings/MembersRosterPanel.tsx`, 267 lines) is *already* the
single component behind Organization → Members and Team → Members,
parameterised by `scope`. So: add `'automatic'` to its `RosterTab` union and one
entry to `rosterTabs`, labelled **Automatic logins**. Its `membersTab` search
param, `TabBar`, `idPrefix`/`role="tabpanel"` wiring and cursor-clearing
`setTab` all carry over. No new tab mechanism.

Four things in that file must change, which revision 1 did not notice:

- `useMemberRoster(scope, …, tab !== 'pending')` (`:109-113`) still fires on the
  new tab — the enabled flag becomes `tab === 'active' || tab === 'deactivated'`,
  and `useMemberInvitations` stays `tab === 'pending'`.
- `const current = tab === 'pending' ? invitations : roster` (`:116`) makes
  `current` the roster on the new tab, so `permissions`/`canInvite` (`:117-118`)
  would derive from it and **"Send invitation" would render on the Automatic
  logins tab** (`:158`). `current` becomes `null` for `'automatic'`, and the
  header action is conditioned on the tab.
- `QueryState` (`:169-173`) gates the whole tab body on the roster fetch, so a
  roster error would blank the rules panel. The roster branch moves inside the
  tab conditional.
- `PaginationFooter` (`:216`) renders outside the branch; it moves inside so it
  does not appear under the rules panel.

**`AutomaticMembershipRulesPanel`** — new, `admin/src/components/features/settings/`,
props `{ scope: 'organization' | 'team' }`. It renders `Section`s, **not** a
second `SettingsPanel`: `docs/standards/design-system.md` states "no nesting — a
card never contains a card, a bordered box never sits inside a bordered box",
and `MembersRosterPanel` is already inside one. Split to stay under the
500-line cap:

| File | Contents |
|---|---|
| `AutomaticMembershipRulesPanel.tsx` | Layout, `QueryState`, kill switch, empty/blocked states, dialogs |
| `AutomaticMembershipDomainRow.tsx` | One domain: `Pill` status chip, health chip, last-check line, actions |
| `AutomaticMembershipDnsPanel.tsx` | Record name/value with copy, rotate, verify |
| `AutomaticMembershipTeamPicker.tsx` | Org-only checkbox set of teams |
| `AutomaticMembershipReconcileStatus.tsx` | Counters, failures, Stop, Run again |

Reused, not forked: `Section`, `Pill` for status chips (there is no `RoleBadge`
in this codebase — `Pill` is the chip primitive), `Checkbox` in the bordered
scroll-box pattern `MemberDetailsDialog:138-149` already uses, `Switch` for the
kill switch, `Dialog` / `ConfirmDialog`, `FormField` / `Input` / `FormActions` /
`FormError` / `FormSuccess`, `FeedbackBanner`, `Notice`, `EmptyState`,
`QueryState`, `useToasts`, and `usePagedList` + `PaginationFooter` for the audit
history — which per `docs/standards/design-system.md` must page through
`PaginationParamsSchema`/`PaginationMetaSchema` and show "Page X of Y" plus the
shared items-per-page picker, like every other admin list.

Reconciliation progress follows the `ConnectProgress` stepped-status shape; no
`ProgressBar` primitive is invented. **No realtime event is added** — revision 1
proposed `publishWs('automatic-membership.backfill', …)`, but `WsEventSchema` is
a closed `z.union` that `publishWs` parses through, so an undeclared event
throws at publish time and adding one is a schema change plus a scope decision
plus a client subscription. The panel polls the run row through its facade with
a `refetchInterval` while a run is `queued`/`running`, and stops when it is not.

**Facade.** `admin/src/facades/automatic-membership/hooks.ts`; keys in
`admin/src/lib/query-keys.ts`. Mutations invalidate on success only; no
optimistic state, because DNS and UOA are the authority.

**States:** loading; feature-disabled (tab absent); empty; pending-DNS with
instructions and a "checked once, waiting for a second confirmation" line;
verification-failed with the resolver's reason; verified-not-active with the
activation confirm; active; suspended with cause; revoked; claimed-elsewhere;
classifier-rejected with the specific reason; **needs-re-authorization with a
Re-authorize button** (§4.3). The org read-only state revision 1 described is
deleted — it is unreachable, because `SettingsMembersPage.tsx:186-190` already
wraps the org panel in `OrganizationAdministrationGate`.

**Accessibility.** `TabBar`'s existing roving-tabindex `role="tablist"` with a
paired `role="tabpanel"`; every checkbox labelled and the picker a
`fieldset`/`legend`; DNS instructions a `<dl>` with the copy button announcing
through `role="status"`; focus-trapped `ConfirmDialog`; status conveyed by text
in the chip, never colour alone; live counters in `role="status"`
(`aria-live="polite"`), not an alert.

**Rule zero — home and doorways.** Home: the Automatic logins tab. Doorways:
the two Members surfaces already in the sidebar, **plus** a line in
`MemberInvitationDialog` — "Adding lots of people from one company? Set up
automatic team access." — because the invitation dialog is where a person is
standing when the question actually arises. No new route, so no `router.tsx` or
`navigation/surfaces.ts` change.

## 15. Test plan

**Unit (pure).** Normalisation table: Unicode/IDNA and confusable folding,
trailing dot, uppercase, punycode round-trip, whitespace, `@`, oversize labels;
IPv4/IPv6/bracketed literals; `localhost`, `*.local`; public suffixes (`co.uk`,
`com`, `github.io`) rejected and `example.co.uk` accepted; every consumer
provider in the list; exact-match-only (`sub.example.com` does not match
`example.com`).

**Unit (api/worker).** Challenge format and entropy; TXT comparison with
multi-chunk joining and several records at the name; the two-observation
requirement and the 10-minute floor; challenge expiry; every state transition
including each refusal and `revoked → pending`; permission resolution for org
admin, team admin of this team, team admin of another team, plain member; **the
grant call never carries `teamRole`**; the challenge is stripped from every
non-org-admin response.

**Integration (Postgres, gated on `DATABASE_URL`, run through Turbo).** Claim →
two DNS observations → verify → activate; instance-wide exclusivity across two
organisations including the pending/pending race where both prove DNS and
exactly one wins; revoke then re-claim the same domain in the same organisation;
sign-in provisioning with a fake UOA relay — matching grants, non-matching does
not, suspended does not, kill switch off does not, `needs_reauthorization` does
not; **an existing team `owner` survives a grant with their role intact**;
overlapping rules grant once; concurrent duplicate sign-in events produce one
ledger row and one upstream call; **a dead provision job does not prevent the
next sign-in from provisioning**; **no email appears in any `queue_jobs`
payload**; **a sign-in grant racing a reconciliation grant for the same
`(rule, sub)` produces one upstream call**; a 403 from UOA moves the rule to
`needs_reauthorization`, alerts once per revision, and reauthorize restores it;
reconciliation resumes from a cursor after a simulated crash, is superseded by a
rule change mid-run, is cancellable, and re-grants nobody on replay; tenant
isolation — an org admin of A cannot read, verify or attach anything in B; audit
rows exist for every lifecycle event and contain no challenge and no email.

DB-suite discipline per `AGENTS.md`: scope cleanup to the suite's own seed,
assert the seed's own outcome rather than any global count, never depend on a
globally-scoped lookup.

**Migration.** Confirm the new folder converges the checked-in
`upgrade-fixtures/baseline.sql.gz` under the existing `upgrade-path` job, and
that `pnpm lint:migrations` is clean (the partial unique indexes are created on
new empty tables, so `CONCURRENTLY` is unnecessary and the lint's warned tables
are untouched).

**Admin unit** (`admin/test/`, existing jsdom harness). Tab appears/does not by
flag and permission; org scope renders the team picker and team scope does not;
each state renders its named copy; the copy control and its `role="status"`
announcement; the Re-authorize button appears only for
`needs_reauthorization`; **"Send invitation" does not render on the Automatic
logins tab**; **a roster error does not blank the rules panel**; a `tab-bar`
regression case proving no second strip was introduced.

**Playwright**, headless at `http://localhost:5455` per `AGENTS.md` →
"Verification". Both surfaces render and screenshot; claim a domain and see the
DNS instructions; a verified domain's team checkboxes save; the activation
confirm appears; reconciliation status and Stop render; keyboard-only traversal
of the tab strip and the checkbox group; a non-admin session sees no management
controls.

## 16. Rollout sequencing

1. **Verify two upstream facts and record the answers here**, because the
   feature's honesty depends on them: (a) does UOA's organisation join policy
   for this deployment require an admin act, per §4.1 — if it is self-serve,
   stop and wait for `email_verified`; (b) does an org-scoped subject assertion
   authorize `listOrganisationMembers` and `addTeamMember` for an org admin
   against an arbitrary team in their org, as `organization-members.ts:358` and
   `uoa-org-members.ts:70` imply.
2. `email-domain.ts` + `tldts` + the consumer list. No callers.
3. Migration, Prisma models, audit-enum entries, `challenge` added to
   `REDACTED_FIELDS`. Additive; nothing reads them yet.
4. API routes, service, DNS verifier — behind the instance flag, default off.
5. Worker: the grant helper, provision topic, revalidation tick. The sign-in
   enqueue lands **last** in this step, so the consumer exists before any
   producer.
6. Admin: facade, panel, tab, invitation-dialog doorway.
7. Reconciliation model, job, rate limiter, status UI, cancel route.
8. Docs in the same turn: the 2026-08-20 plan marked superseded; a routed
   sentence in `AGENTS.md` → Architecture and in
   `docs/standards/team-model.md` naming this as the one place Nessie policy
   decides team placement while UOA still owns and authorizes the membership;
   `docs/functionality.md` updated. This plan stays in `docs/plans/` while the
   flag is off by default — it is the routed reference `AGENTS.md` points at,
   and moving it to `docs/done/` belongs with the rollout that turns the flag
   on.

Every step is backward-compatible: new tables are unread until step 4, the flag
is off until an operator turns it on, and the migration infers, creates and
activates nothing.

## 17. Non-goals

- Nessie does not authenticate anybody by domain, and no copy suggests it.
- Nessie writes no membership row of its own; every grant is a UOA relay,
  authorized upstream by a live principal, and every removal stays manual.
- Backend mode (no acting user) is not used anywhere in this feature.
- No admin or owner role is ever granted, and no role is ever sent.
- No org-level admission: rules place existing organisation members into teams.
- Subdomains are never implied by a parent claim.
- No surface for local/no-IdP installs or generic-OIDC tenants.
- No broad list of matching people is shown to an administrator — counters only.
- No new tab framework, table, chip, dialog, progress or realtime primitive.

## 18. As-built deltas

What the code does differently from the plan above, each found in the code
review and fixed rather than papered over.

- **Reconciliation runs carry a monotonic `step`**, and every queue job for a
  run is keyed on it. The plan keyed retries on `attempts` and pages on the
  cursor; `attempts` is reset after each successful page and a stale-cursor
  restart re-walks pages, so both reuse keys — and the queue's unique
  idempotency index is permanent with an `ON CONFLICT DO NOTHING` insert that
  nothing purges. A reused key enqueued nothing and stalled the run in
  `running` for good. The enqueue's boolean result is now checked, and a
  five-minute sweep re-enqueues a run whose job never landed.
- **The instance flag reaches the grant path.** The plan gated it in the routes
  only, which 404 when it is off — taking the per-organisation emergency stop
  with them — while sign-in and the workers kept granting on existing rules.
- **A lapsed rule writes `UserAlert` rows** for the organisation's owners and
  admins, once per `healthRevision`, linked to the rule so the alert clears
  itself on re-authorization. The plan described the state and the audit entry
  but no alert, which is the exact failure
  `docs/standards/capability-health-alerts.md` was written after.
- **The team surface lists every proven domain**, not only those already
  granting that team. Filtering to attached domains made the toggle one-way and
  left the attach path with no doorway. Domain names are not the secret; the
  challenge is, and it is still stripped for this reader. Team owners/admins
  also have their own re-authorize route — the organisation one is
  organisation-admin gated, so the button they were shown could only have 403'd.
- **The sign-in enqueue runs inside a `SAVEPOINT`.** It sits in
  `ensureTeamPrincipal`'s transaction, so a SQL-level failure would abort the
  whole transaction and fail the login that the surrounding `catch` was there
  to protect.
- **Detaching a team disables its rule rather than deleting it**, so the grant
  ledger survives and a re-attach does not re-walk everybody.
- **`skipped_no_such_team` is retryable, not terminal.** The per-subject
  pre-read answers within the authorizer's own authority, so a temporary scope
  reduction would otherwise have burned that person for that rule permanently.
- **Every upstream request is paced**, not one per grant: a grant makes two
  (the pre-read and the add), so the rate limit was effectively double.
- **Activation is confirmed and starts reconciliation**, naming the domain and
  the teams — §13 leans on that confirmation as the mitigation for the residual
  "domain hosts third-party mailboxes" risk in §6. Pausing the organisation is
  confirmed too.
- **A re-check no longer lifts a suspension.** §7's table has no
  `suspended → verified` transition; resuming stays an explicit act.
- **`grant_issued` is audited only for an actual grant**, never for a skip, and
  reconciliation audits its grants too.
- **The route module is three files.** It reached 543 lines, past the 500-line
  cap, and split along the seam already there: the team surface answers to a
  different gate, and the shared feature gate, error mapping and rule-change
  audit are a small support module.
