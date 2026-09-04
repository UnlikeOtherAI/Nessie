# Automatic team access after sign-in, by DNS-verified email domain

**Status:** Proposed — plan only, no code written.
**Supersedes:** `docs/plans/2026-08-20-nessie-corporate-domain-auto-enrolment-surface.md`
(that plan waited on UOA endpoints that were never shipped; nothing of it exists
in code). §"Relationship to the superseded plan" says what is kept and what is
deliberately reversed.
**Owning surfaces:** Organization → Members, and Team → Members — a new
**Automatic logins** tab on each, drawn by one shared component.

## 1. Outcome and terminology

An administrator proves the organisation controls an email domain, then names
the teams that people from that domain should land in. When a person from that
domain signs in, they are placed into those teams as an ordinary **member**.

The UI never says or implies that a domain authenticates anybody. UOA
authenticates; the domain only decides *where a person already authenticated
lands*. Fixed copy:

| Element | Copy |
|---|---|
| Tab label | **Automatic logins** |
| Panel title | **Automatic team access after sign-in** |
| Panel lede | "When someone signs in with a verified email address at a domain you control, add them to these teams as a member. Their identity is always verified by sign-in — a domain never signs anyone in." |
| Rule state | Pending DNS · Verified · Active · Suspended · Revoked |
| Confirm step | "Add existing matching people to *Team* now?" |

Never used anywhere in this feature: "auto-login", "domain login", "trusted
domain", "SSO domain", "domain authentication".

## 2. What is true today — the constraints this plan is built on

Four facts were established by reading the code, not assumed. Each one changes
the design, so each is stated before the design that answers it.

**C1 — UOA is the sole authority for team membership; Nessie may relay a
grant, never write one.** `docs/brief.md` → "Current SSO identity invariant"
and `docs/standards/team-model.md` are explicit, and the code matches:
`api/src/routes/team-members.ts` persists nothing, it relays to
`addTeamMember` (`packages/team-admin/src/uoa-org-roster-pages.ts`). Local
`TeamMember` rows are written in exactly one place — `ensureTeamMemberships`
(`api/src/services/team-principal.ts`) — and only from claims UOA returned.
*Consequence:* an automatic grant is a call to `addTeamMember`, the same
function the "Add member" button calls. Nessie writes no membership row of its
own, ever.

**C2 — UOA does not assert `email_verified`.** `resolveUoaIdentityFromAccessToken`
(`api/src/services/uoa-session.ts`) parses `sub`, `email`, `name`, `tv`, `org.*`
and `active.*` — no verification flag. The only `email_verified` check in the
repo is the generic-OIDC branch of `api/src/services/external-auth.ts`, and it
rejects only an explicit `false`. *Consequence:* "a currently verified email
asserted by UOA" has no field behind it today. §4.1 is the decision this forces,
and it is the one item that needs a human call.

**C3 — UOA has no "identities matching a domain" query.** The org API offers
`listOrganisationMembers(orgId, { cursor, limit, status })` (cursor-paged,
returns `uoaSub`, `email`, `orgRole`, `status`) and a team-scoped free-text
`findTeamMemberCandidates`. Nothing takes a domain. *Consequence:* backfill
pages the organisation roster and filters on the domain locally, per batch,
from live UOA data — never from a copied email cache (§8).

**C4 — the population is already inside the UOA organisation.** A person can
only reach this tenant by signing in with a UOA token carrying an
`active.orgId` that maps to this `Organization.externalOrgId`. So a domain rule
can never admit a stranger to the organisation; it can only place an existing
organisation member into teams **inside the organisation they are already in**.
*Consequence:* this is a team-placement feature, not an admission feature —
which is what makes it compatible with C1 and with the superseded plan's
objection to inferring eligibility from an email address (§16).

## 3. Relationship to the superseded plan

Kept: UOA owns identity and membership; no local profile copies; the UOA
subject is the only person key; fail-closed error mapping; no surface for
local/no-IdP installs.

Deliberately reversed, and why: the 2026-08-20 plan made Nessie a pure relay of
a *UOA-owned* domain claim, gated on a `corporate_domain_auto_enrolment_management`
signed-config flag and an `X-UOA-Management-Assertion`. UOA never shipped any of
it, and there is no date for it. This plan holds the **policy** (which domain,
which teams, DNS proof, audit, backfill) in Nessie, and keeps the **membership**
in UOA. That split preserves C1 — the invariant the old plan was protecting —
while removing the upstream dependency. If UOA later ships the claim model, the
DNS-proof half of this feature is what migrates; the tab, the rules, the
backfill and the audit stay.

Mark the old plan superseded in the same commit as this one; do not delete it.

## 4. Decisions

### 4.1 The verification fact — needs a human call (recommended: B)

C2 leaves three options:

- **A — block.** Ship nothing until UOA asserts `email_verified`. Honest,
  delivers nothing.
- **B — require the claim, fail closed, forward-compatible.** Parse an optional
  `email_verified` from the UOA access token into
  `ExternalAuthIdentity.emailVerified?: boolean`. Automatic provisioning
  requires `emailVerified === true`. Because UOA does not send it today, the
  feature is configurable but **provisions nobody** until UOA does — and the
  admin UI says exactly that, by name, in a warning state on every rule. An
  instance-level escape hatch, `NESSIE_AUTOMATIC_MEMBERSHIP_TRUST_UOA_EMAIL`
  (default **false**), treats an org-membership-active UOA email as the
  verified fact for operators who accept that risk; turning it on is recorded
  in the audit trail and rendered in the panel as "Trusting UOA sign-in email
  without a verification claim".
- **C — trust the UOA email unconditionally.** Simplest, and directly violates
  "email confirmation alone is not sufficient" in spirit.

**Recommendation: B.** It satisfies "use only a currently verified email
asserted by UOA" the moment UOA asserts one, fails closed until then, and never
silently pretends. The cost is that a default install sees the feature do
nothing, so the empty/blocked state must be loud and self-explanatory — that is
a UI requirement in §11, not a footnote.

Generic-OIDC sessions keep their existing rule (reject explicit `false`); they
are not part of this feature's scope because domain rules are org-scoped and
generic-OIDC tenants have no `externalOrgId`.

### 4.2 The grant is a UOA relay in backend mode

Provisioning and backfill call `addTeamMember(team, { uoaSub, teamRole: 'member' })`
with `deps.subjectAssertion` **absent** — UOA "backend mode", which
`org_features.backend_org_management: true` already enables and which
`api/src/services/uoa-auth.ts` documents as *"no acting user, so UOA applies no
per-member role check; the owner/admin gate is what authorises every
mutation."* Nessie's gate here is: an organisation admin configured the rule,
the domain passed DNS proof, and the rule is active — all audited.

The `X-UOA-Subject-Assertion` path is unusable for this: it is a 60-second
token bound to a live signed-in person, and neither the sign-in hook (acting as
the arriving member, who has no right to add themselves) nor the durable
backfill job (which outlives any session) has one.

**Integration risk, to be settled in step 1 of §13 before anything else is
built:** whether UOA accepts `GET /org/organisations/:id/members` in backend
mode and whether it discloses `email` there (`permissions.viewMemberEmail`).
A probe script against the configured UOA answers both. If listing is refused
or emails are withheld, sign-in provisioning still works unchanged (it reads
the email from the arriving token, not from the roster) and **backfill is not
shipped**; the panel then states that existing people must be added manually.
Backfill is not worth a delegated-assertion scheme that mints tokens for an
admin who is not present.

Every upstream call resolves `externalOrgId` from the tenant `Organization`
row server-side. No caller-supplied organisation id is accepted anywhere —
that is the mitigation for the domain-hash-as-estate-key concern in
`docs/plans/2026-09-02-uoa-as-a-service-unification.md` §3a.

### 4.3 Permission boundary

Two different objects, two different gates:

- **A domain claim** (create, DNS verify, rotate challenge, suspend, revoke,
  set notification email) is **organisation owner/admin only**, via the
  existing `resolveOrganizationAdministrationAccess`. Rationale: a verified
  domain is exclusive to one organisation instance-wide (§5), so claiming one
  is an organisation-level act. A team admin must not be able to take an
  organisation-wide lock.
- **A grant rule** — "this verified domain also grants team T" — is managed by
  organisation owners/admins for any team, and by **team owners/admins for
  their own team only**, checked server-side against
  `team.project.organizationId` and the caller's team role.

`teamRole` on every automatic grant is the literal string `'member'`. The
request body has no role field; there is nothing for a caller to escalate.

### 4.4 Rules are additive only

Narrowing, suspending, revoking or failing revalidation stops **future**
provisioning and nothing else. No code path in this feature removes a
membership, changes a role, or downgrades anyone. Removal stays the explicit
"Remove member" action that already exists. The backfill and the sign-in hook
share one grant helper, and that helper's only mutation is `addTeamMember`.

### 4.5 Stronger roles are preserved

`addTeamMember` is called only when the person is not already on the team. If
UOA answers "already a member" (a 4xx `UoaRosterRejectedError` whose upstream
code says so), that is recorded as `skipped_existing`, not an error, and the
existing role — which may be `admin` or `owner` — is left untouched.

## 5. Data model

Three new tables. Additive migration, new folder
`api/prisma/migrations/20260904HHMMSS_automatic_membership_rules/`. No existing
table changes shape.

```prisma
enum AutomaticMembershipDomainStatus {
  pending      // created, challenge issued, DNS not yet proven
  verified     // DNS proven, not yet switched on
  active       // DNS proven and provisioning enabled
  suspended    // admin paused, or revalidation failed/expired
  revoked      // released; frees the instance-wide domain lock
}

model AutomaticMembershipDomain {
  id                String   @id @default(uuid()) @db.Uuid
  organizationId    String   @map("organization_id") @db.Uuid
  /** Normalised, lowercase, IDNA/punycode, no trailing dot. Exact match only. */
  domain            String
  status            AutomaticMembershipDomainStatus @default(pending)
  /** Random 32-byte challenge, base32, rotated on demand. Not a secret at rest
   *  (it is published in DNS) but never written to the audit chain. */
  challenge         String   @map("challenge")
  challengeIssuedAt DateTime @map("challenge_issued_at")
  challengeExpiresAt DateTime @map("challenge_expires_at")
  verifiedAt        DateTime? @map("verified_at")
  lastCheckedAt     DateTime? @map("last_checked_at")
  lastCheckOutcome  String?   @map("last_check_outcome")
  lastCheckDetail   String?   @map("last_check_detail")
  revalidationFailures Int    @default(0) @map("revalidation_failures")
  /** Optional. Receives notifications. Confers no authority whatsoever. */
  notificationEmail String?  @map("notification_email")
  createdByUserId   String?  @map("created_by_user_id") @db.Uuid
  createdAt         DateTime @default(now()) @map("created_at")
  updatedAt         DateTime @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  rules        AutomaticMembershipRule[]
  backfillRuns AutomaticMembershipBackfillRun[]

  @@unique([organizationId, domain])
  @@index([status, lastCheckedAt])
  @@map("automatic_membership_domains")
}
```

**Instance-wide exclusivity** is a partial unique index, written as raw SQL in
the migration because Prisma cannot express it:

```sql
CREATE UNIQUE INDEX automatic_membership_domains_claimed_domain_key
  ON automatic_membership_domains (domain)
  WHERE status IN ('verified', 'active', 'suspended');
```

`pending` is excluded so two organisations may both attempt a claim; the first
to pass DNS wins the lock and the loser's verification then fails with
`AUTOMATIC_MEMBERSHIP_DOMAIN_CLAIMED`. `revoked` is excluded so releasing a
domain frees it. A conflicting organisation is told to use manual invitations
until the claim is released — the error message says exactly that and names no
other organisation.

```prisma
model AutomaticMembershipRule {
  id           String   @id @default(uuid()) @db.Uuid
  domainId     String   @map("domain_id") @db.Uuid
  /** The Nessie team (a UOA team) that matching people are added to. */
  teamId       String   @map("team_id") @db.Uuid
  /** Which surface created it. Presentation and audit only; the permission
   *  check is always re-derived server-side from the caller, never from this. */
  createdScope String   @map("created_scope")   // 'organization' | 'team'
  enabled      Boolean  @default(true)
  createdByUserId String? @map("created_by_user_id") @db.Uuid
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  domain AutomaticMembershipDomain @relation(fields: [domainId], references: [id], onDelete: Cascade)
  team   Team                      @relation(fields: [teamId], references: [id], onDelete: Cascade)
  grants AutomaticMembershipGrant[]

  @@unique([domainId, teamId])
  @@index([teamId])
  @@map("automatic_membership_rules")
}

/** One row per (rule, person) actually granted. The idempotency ledger: it is
 *  what makes a retry, a duplicate sign-in event and an overlapping rule free. */
model AutomaticMembershipGrant {
  id         String   @id @default(uuid()) @db.Uuid
  ruleId     String   @map("rule_id") @db.Uuid
  /** UOA subject. Never a local user id, never an email. */
  uoaSub     String   @map("uoa_sub")
  outcome    String                    // 'granted' | 'skipped_existing'
  source     String                    // 'signin' | 'backfill'
  grantedAt  DateTime @default(now()) @map("granted_at")

  rule AutomaticMembershipRule @relation(fields: [ruleId], references: [id], onDelete: Cascade)

  @@unique([ruleId, uoaSub])
  @@map("automatic_membership_grants")
}

model AutomaticMembershipBackfillRun {
  id            String   @id @default(uuid()) @db.Uuid
  domainId      String   @map("domain_id") @db.Uuid
  /** Snapshot of the rule ids this run was started for; a change supersedes it. */
  ruleIds       String[] @map("rule_ids")
  status        String   @default("queued") // queued|running|completed|failed|superseded|cancelled
  cursor        String?
  scanned       Int      @default(0)
  matched       Int      @default(0)
  granted       Int      @default(0)
  skipped       Int      @default(0)
  failed        Int      @default(0)
  lastError     String?  @map("last_error")
  startedAt     DateTime? @map("started_at")
  finishedAt    DateTime? @map("finished_at")
  requestedByUserId String? @map("requested_by_user_id") @db.Uuid
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  domain AutomaticMembershipDomain @relation(fields: [domainId], references: [id], onDelete: Cascade)

  @@index([domainId, status])
  @@map("automatic_membership_backfill_runs")
}
```

No email, display name or avatar is stored anywhere in this feature. The only
person identifier persisted is `uoaSub`, per `docs/standards/team-model.md`.

## 6. Domain normalisation and the classifier

New package `packages/email-domain-policy` (source of truth for both api and
worker; the api/worker split forbids reaching into each other).

```ts
export type DomainRejection =
  | 'malformed' | 'ip_literal' | 'localhost' | 'public_suffix'
  | 'single_label' | 'too_long' | 'consumer_provider' | 'disposable'

export type DomainDecision =
  | { ok: true; domain: string }          // normalised, punycode, lowercase
  | { ok: false; reason: DomainRejection }

export const normaliseDomain = (input: string): DomainDecision
export const classifyEmailDomain = (domain: string): DomainDecision
export const domainOfEmail = (email: string): string | null
```

Normalisation, in order: trim; strip a single trailing dot; reject anything
containing whitespace, `@`, `/` or `:`; lowercase; IDNA-to-ASCII via
`URL`/`node:url` `domainToASCII` (empty result → `malformed`); reject if it
parses as an IPv4 or IPv6 literal (including bracketed forms); reject
`localhost` and any `*.localhost` / `*.local`; reject a single label; reject
length > 253 or any label > 63.

Classification uses two pinned, vendored data sources plus one library:

- **`tldts`** (MIT, 7.4.x, actively maintained — weekly PSL refresh) for the
  public-suffix test. Reject when the domain **is** a public suffix
  (`example.co.uk` is fine; `co.uk` is not) and when `tldts` reports no
  registrable domain. ICANN section only, which is `tldts`'s default.
- **`free-email-domains`** (MIT, 1.11.x, refreshed within days of writing) —
  consumer/free providers: Gmail, Outlook/Hotmail/Live/MSN, Yahoo, iCloud/me/mac,
  Proton, GMX, Mail.ru, Yandex, AOL and thousands more.
- **`disposable-email-domains-js`** (CC0, 1.25.x, generated from the
  `disposable-email-domains` community list) — throwaway providers.

Both lists are **vendored and checksummed**, following the existing
`packages/billing-statement-protocol.upstream.sha256` +
`scripts/verify-billing-protocol-vendor.mjs` convention: a sibling
`scripts/verify-email-domain-lists.mjs` added to root `pnpm lint`, and
`scripts/refresh-email-domain-lists.mjs` to pull a new snapshot deliberately.
Rationale: the classifier is a security control, so it must be auditable in the
diff and must not change under the feet of a release. A hand-curated
`packages/email-domain-policy/src/extra-consumer-domains.ts` covers anything
the upstream lists miss, with a comment per entry.

The classifier runs at **claim time** and again at **grant time**. A domain
that becomes consumer/disposable after a list refresh stops provisioning at the
next grant, and the panel shows the reason.

## 7. DNS verification lifecycle

**Record.** TXT at `_nessie-domain-verification.<domain>`, value
`nessie-domain-verification=<challenge>`, where `<challenge>` is 32 bytes from
`crypto.randomBytes` in unpadded base32. A host-level record was chosen over an
apex TXT so it cannot collide with SPF/DMARC and so it is visible in the
panel's copy-to-clipboard block as a single line.

**Resolver seam.** `resolveTxt` from `node:dns/promises`, injected as a
`DomainVerificationDns = { txt: (name: string) => Promise<string[][]> }` — the
same testable-seam shape `packages/agent-mail/src/mailbox-discovery.ts`
already uses. One 5-second budget, no retries inside a single check; a check is
cheap to repeat. Records are joined per RFC 1035 chunking before comparison,
compared with `crypto.timingSafeEqual` on equal-length buffers, and a domain
passes if **any** TXT record at the name matches.

**States and transitions.**

| From | Event | To |
|---|---|---|
| — | admin claims domain | `pending` (challenge issued, 7-day expiry) |
| `pending` | DNS check passes, lock free | `verified` |
| `pending` | DNS check passes, lock taken | stays `pending`, error `DOMAIN_CLAIMED` |
| `pending` | challenge expires | stays `pending`, must rotate |
| `pending`/`verified`/`active`/`suspended` | admin rotates challenge | `pending` (new challenge, verification must be redone) |
| `verified` | admin activates (confirm dialog) | `active` + backfill enqueued |
| `active` | admin suspends, or kill switch | `suspended` |
| `active` | 3 consecutive revalidation failures | `suspended` |
| `suspended` | DNS revalidation passes + admin resumes | `active` |
| any | admin revokes | `revoked` (lock released, rules retained but inert) |

**Revalidation.** A `setInterval` in `worker/src/index.ts` alongside the
existing sweeps (12-hour cadence, `inFlight` guard, cleared in `stop()`), which
enqueues one `automatic-membership.revalidate` job per due domain with a
window-bucketed idempotency key
`auto-membership:revalidate:${domainId}:${bucket}` — the established
multi-replica-safe pattern from `enqueueCommsSubscriptionsRenew`. A domain is
due 24 hours after `lastCheckedAt`. Three consecutive failures suspends it and
notifies `notificationEmail` if set; a success resets the counter. Suspension
never removes anybody (§4.4).

## 8. Provisioning at sign-in

`ensureTeamPrincipal` already runs inside a transaction on the login path. It
gains **one** additional statement, at the end, in the same transaction:

```ts
await enqueueQueueJob(transaction, {
  topic: AUTOMATIC_MEMBERSHIP_PROVISION_TOPIC,
  payload: { organizationId, uoaSub, email, emailVerified },
  idempotencyKey: `auto-membership:provision:${organizationId}:${uoaSub}:${rulesRevision}`,
})
```

`enqueueQueueJob` takes a transaction client (it needs only `$executeRaw`), so
the enqueue is atomic with the principal write. `rulesRevision` is the
`max(updatedAt)` epoch-seconds across the org's domains and rules, so a sign-in
after a rule change re-evaluates while repeated sign-ins under an unchanged
rule set collapse to one job by the queue's `ON CONFLICT DO NOTHING`.

Sign-in never waits for the grant and never fails because of it. The person's
new teams appear in the team switcher on their next directory read, which is
the same path any UOA-side membership change already takes.

The worker handler:

1. Re-reads the instance flag, the org kill switch, and the org's `active`
   domains. Nothing to do → acknowledge.
2. Rejects unless `emailVerified === true` (§4.1).
3. `domainOfEmail(email)` → `classifyEmailDomain` → exact match against an
   `active` domain. Subdomains do not match; `sub.example.com` needs its own
   claim.
4. For each enabled rule on that domain, in a per-rule transaction: insert the
   `AutomaticMembershipGrant` row first (`@@unique([ruleId, uoaSub])` — a
   conflict means another worker or an earlier attempt owns this grant, so
   skip), then call `addTeamMember`. If the upstream call fails, the row is
   rolled back so a retry is possible; if it reports "already a member", the
   row is committed with `outcome: 'skipped_existing'`.
5. Emits one audit event per grant.

Overlapping rules are naturally idempotent: two domains both pointing at team T
produce two rule rows, and the second `addTeamMember` resolves to
`skipped_existing`.

## 9. Backfill

Enqueued when a domain is activated and when a rule's team set changes. A new
`AutomaticMembershipBackfillRun` row supersedes any `queued`/`running` run for
the same domain (`status = 'superseded'`), and each batch re-reads its own row
and stops immediately if it is no longer the current run — cancellation and
supersession in one mechanism.

Topic `automatic-membership.backfill`, one job per batch, self-continuing —
the `executeCommsIncrementalSweepJob` shape from
`worker/src/control/comms-sync.ts`:

```
per batch (limit 50):
  reload run row; if superseded/cancelled -> stop
  re-check: instance flag, org kill switch, domain status === 'active',
            rule set unchanged, domain still passes the classifier
  listOrganisationMembers(externalOrgId, { cursor, limit: 50 }) // backend mode
  filter: status ACTIVE, email present, domainOfEmail(email) === domain
  for each match, for each enabled rule -> shared grant helper (§8 step 4)
  persist cursor + counters on the run row
  publishWs('automatic-membership.backfill', { domainId, runId }) to the org
  if meta.hasMore -> enqueue next batch with delayMs = BATCH_PAUSE_MS
  else -> status 'completed'
```

- **Rate limits.** `BATCH_PAUSE_MS` of 1000 between batches, and at most one
  in-flight run per domain by construction (the supersession rule). That caps a
  tenant at ~50 upstream member-reads/second-equivalent and bounds grant calls
  to the same rhythm.
- **Retries.** On a `UoaRosterUnavailableError`, re-enqueue the same batch with
  `exponentialBackoffMs({ attempt, baseMs: 30_000, capMs: 30 * 60_000 })` from
  `@nessie/runtime`, up to 5 attempts, then `status: 'failed'` with
  `lastError`. A `UoaRosterRejectedError` (4xx) fails the run immediately —
  retrying a refusal is pointless.
- **Idempotency.** The grant ledger (§5) means a resumed or duplicated batch
  re-grants nobody.
- **No broad list of people.** The run row holds counters and a cursor, never
  names or addresses. §11 renders exactly those counters.

**Not shipped if the §4.2 probe fails.** In that case activation still works,
sign-in provisioning still works, and the panel says existing people must be
added manually.

## 10. Feature flag and kill switch

Two independent switches, both fail-closed:

- **Instance rollout flag** — `packages/config`: `automaticMembership.enabled`
  (`NESSIE_AUTOMATIC_MEMBERSHIP_ENABLED`, default `false`) plus
  `automaticMembership.trustUoaEmail`
  (`NESSIE_AUTOMATIC_MEMBERSHIP_TRUST_UOA_EMAIL`, default `false`, §4.1). With
  the flag off the routes answer `404` and the tab is not rendered.
- **Per-organisation kill switch** — a `ScopedSetting` at organisation scope,
  key `automaticMembership.enabled`, via `resolveScopedSetting` /
  `writeScopedSetting` (`packages/runtime/src/scoped-settings.ts`). This is the
  sanctioned cascade; `docs/standards/scoped-settings.md` calls a hand-rolled
  fifth cascade a defect. Turning it off stops the sign-in hook and every
  backfill batch at their next check. Memberships, rules, grant ledger and
  audit are all preserved; nothing is deleted and nobody is removed.

Both are re-read at the top of every job batch, not cached.

## 11. API surface

New module `api/src/routes/automatic-membership.ts`, registered in
`api/src/register-api-routes.ts`. Fastify, `parseInput` for bodies,
`sendApiError` for failures, `createApiResponse` for successes — the house
conventions.

| Method | Path | Gate |
|---|---|---|
| `GET` | `/api/organization/automatic-membership` | org admin |
| `POST` | `/api/organization/automatic-membership/domains` | org admin |
| `POST` | `.../domains/:id/verify` | org admin |
| `POST` | `.../domains/:id/rotate-challenge` | org admin |
| `PATCH` | `.../domains/:id` (status, notificationEmail) | org admin |
| `DELETE` | `.../domains/:id` (revoke) | org admin |
| `PUT` | `.../domains/:id/teams` (checkbox set) | org admin |
| `POST` | `.../domains/:id/backfill` | org admin |
| `GET` | `/api/team/automatic-membership` | team member (read), gated fields |
| `PUT` | `/api/team/automatic-membership/domains/:id` (attach/detach this team) | team owner/admin of *this* team |

Both `GET`s return the same shape — `{ domains: [...], permissions: {...} }` —
so one panel renders both. The team variant returns only domains that already
have a rule for this team or are `active` and attachable, and it never returns
another team's rule rows.

Error codes, fail-closed and non-enumerating:
`AUTOMATIC_MEMBERSHIP_DISABLED` (404, flag off),
`ORGANIZATION_NOT_LINKED` (404, no `externalOrgId`),
`ORGANIZATION_ADMIN_REQUIRED` / `TEAM_ADMIN_REQUIRED` (403),
`AUTOMATIC_MEMBERSHIP_DOMAIN_REJECTED` (400, carries the `DomainRejection`),
`AUTOMATIC_MEMBERSHIP_DOMAIN_CLAIMED` (409),
`AUTOMATIC_MEMBERSHIP_DNS_UNVERIFIED` (409, carries the last check detail),
`UOA_ORGANIZATION_ACCESS_UNAVAILABLE` (503).

The challenge string is returned only to an authorised org admin reading their
own organisation's domains. It is never written to the audit chain, never
logged, and never placed in a URL.

## 12. Audit

Nine new actions appended to `AuditActionSchema`
(`packages/schemas/src/governance.ts`) — the closed enum, not the raw-string
escape hatch:

```
organization.automatic_membership.domain_created
organization.automatic_membership.dns_checked
organization.automatic_membership.domain_verified
organization.automatic_membership.domain_activated
organization.automatic_membership.domain_suspended
organization.automatic_membership.domain_revoked
organization.automatic_membership.challenge_rotated
organization.automatic_membership.contact_email_changed
organization.automatic_membership.rule_changed
organization.automatic_membership.grant_issued
organization.automatic_membership.backfill_started
organization.automatic_membership.backfill_finished
```

Emitted through `emitAuditEvent`, which already redacts a secret-field set and
never throws. Metadata carries `domain`, `domainId`, `ruleId`, `teamId`,
`uoaSub`, `source`, `outcome` and backfill counters — never the challenge,
never an email address. Job-emitted events use an actor context of
`actorType: 'system'` with the requesting admin recorded in metadata.

## 13. UI

**One component, both surfaces.** `MembersRosterPanel`
(`admin/src/pages/settings/MembersRosterPanel.tsx`) is *already* the single
component behind Organization → Members and Team → Members, parameterised by
`scope: 'organization' | 'team'`. So:

- Add `'automatic'` to its `RosterTab` union and one entry to `rosterTabs`,
  labelled **Automatic logins**. Its existing `membersTab` search param, its
  `TabBar`, its `idPrefix`/`role="tabpanel"` wiring and its cursor-clearing
  `setTab` all carry over untouched. No new tab mechanism, no second strip.
- The tab is present only when the instance flag is on and the caller may at
  least read the rules; `MembersRosterPanel` already reads `permissions` from
  the roster response, and the new endpoint returns its own.
- Restructure the existing panel body so `QueryState` + `DataTable` +
  `PaginationFooter` render for the three roster tabs and
  `<AutomaticMembershipRulesPanel scope={scope} />` renders for the new one.
  The pagination footer currently renders outside the tab branch; it moves
  inside so it does not appear under the rules panel.
- `MembersRosterPanel` is 267 lines; this keeps it under the 500-line cap. If
  it approaches the cap, the roster branch moves to a sibling
  `MemberRosterTable.tsx` — a split along the responsibility seam, not a
  `-helpers` dump.

**`AutomaticMembershipRulesPanel`** — new, `admin/src/components/features/settings/`,
props `{ scope: 'organization' | 'team' }`, split across small files to stay
well under the cap:

| File | Contents |
|---|---|
| `AutomaticMembershipRulesPanel.tsx` | Layout, `QueryState`, empty/blocked states, dialog orchestration |
| `AutomaticMembershipDomainRow.tsx` | One domain: `Pill` status chip, last-check line, actions |
| `AutomaticMembershipDnsPanel.tsx` | Record name/value with copy, rotate control, verify button |
| `AutomaticMembershipTeamPicker.tsx` | Org-only checkbox set of teams |
| `AutomaticMembershipBackfillStatus.tsx` | Counters, failure line, live refresh |

Everything reused, nothing forked: `SettingsPanel`, `Section`, `TabBar` (via
the host), `Pill` for status chips (there is no `RoleBadge` in this codebase —
`Pill` is the chip primitive), `Checkbox` in the bordered scroll-box pattern
`MemberDetailsDialog` already uses for workspace access, `Dialog` /
`ConfirmDialog`, `FormField` / `Input` / `FormActions` / `FormError` /
`FormSuccess`, `FeedbackBanner`, `EmptyState`, `QueryState`, `useToasts` for
the activation toast, and `usePagedList` + `PaginationFooter` for the audit
history list. Backfill progress follows the `ConnectProgress` stepped-status
shape — there is no `ProgressBar` primitive and this plan does not invent one;
it renders counters as text with `role="status"`.

**Facade.** `admin/src/facades/automatic-membership/hooks.ts`, keys added to
`admin/src/lib/query-keys.ts` (`automaticMembershipKeys`). Mutations invalidate
the scope's key on success only. No optimistic state — DNS and upstream results
are the authority.

**States, all explicitly designed:** loading; feature-disabled (tab absent);
no-permission (read-only rows, controls absent — not merely disabled); empty
("No domains yet"); pending-DNS with instructions; verification-failed with the
resolver's reason; verified-not-active with the activation confirm; active;
suspended with cause; revoked; domain-claimed-elsewhere; classifier-rejected
with the specific reason; **and the §4.1 blocked state** — a `Notice`
`tone="warning"` reading "Your identity provider does not yet confirm that an
email address is verified, so nobody is added automatically." That state is
loud by design; it is the honest face of C2.

**Accessibility.** The tab strip is `TabBar`'s existing roving-tabindex
`role="tablist"` with a paired `role="tabpanel"`. Every checkbox has a real
label; the picker group is a `fieldset`/`legend`. DNS instructions are a
`<dl>`, and the copy button announces via `role="status"`. Confirm dialogs are
the existing focus-trapped `ConfirmDialog`. Status chips carry text, never
colour alone. Live backfill counters update inside `role="status"`
(`aria-live="polite"`), not an alert.

**Rule zero — home and doorways.** Home: the Automatic logins tab on both
Members surfaces. Doorways: the Members surfaces themselves are already in the
sidebar under Organization and Team, and this sits beside "Send invitation",
which is the adjacent decision ("should these people join automatically instead
of being invited one by one?"). No new route, so no `router.tsx` or
`navigation/surfaces.ts` change and no `lint-navigation-surfaces` exposure.

## 14. Test plan

**Unit** (`packages/email-domain-policy/test/`, `--experimental-test-isolation=none`):
normalisation table (Unicode/IDNA, trailing dot, uppercase, whitespace, `@`,
oversize labels); IP literals v4/v6/bracketed; `localhost`, `*.local`; public
suffixes (`co.uk`, `com`, `github.io`) rejected, `example.co.uk` accepted;
consumer providers — Gmail, googlemail, Outlook, Hotmail, Live, MSN, Yahoo,
ymail, iCloud, me.com, mac.com, Proton, GMX, Yandex, Mail.ru, AOL; disposable
samples; exact-match-only (`sub.example.com` does not match `example.com`);
the vendored-list checksum verifier.

**Unit** (api/worker): challenge generation entropy and format; TXT comparison
including RFC 1035 multi-chunk joining and multiple records at the name;
challenge expiry; state machine transitions incl. every refusal; permission
resolution for org admin / team admin of this team / team admin of another team
/ plain member; role is always `'member'`; the `PUT .../teams` body cannot
carry a role.

**Integration** (Postgres-backed, gated on `DATABASE_URL`, run through Turbo):
domain claim → verify with a fake DNS seam → activate; instance-wide
exclusivity across two organisations, including the pending/pending race where
both verify and exactly one wins; sign-in provisioning with a fake UOA relay —
verified email grants, unverified does not, non-matching domain does not,
suspended rule does not, kill switch off does not; overlapping rules grant once;
concurrent duplicate sign-in events produce exactly one grant row and one
upstream call; existing member with `admin` role is `skipped_existing` and keeps
`admin`; narrowing/suspending/revoking removes nobody; backfill resumes from a
cursor after a simulated crash, is superseded by a rule change mid-run, and
re-grants nobody on replay; tenant isolation — an org admin of A cannot read,
verify or attach anything in B; audit rows exist for every lifecycle event and
contain no challenge and no email.

DB-suite discipline per `AGENTS.md`: scope every cleanup to the suite's own
seed, assert the seed's own outcome rather than any global count, and never
assert on a globally-scoped lookup.

**Migration:** the `upgrade-path` job already replays `prisma migrate deploy`
over the checked-in baseline; confirm the new folder converges it and that
`pnpm lint:migrations` is clean (the partial unique index is created on a new,
empty table, so `CONCURRENTLY` is unnecessary and the lint's warning list does
not cover these tables).

**Admin unit** (`admin/test/`, existing jsdom harness): tab appears/does not
appear by flag and permission; org scope renders the team picker and team scope
does not; read-only rendering for a non-admin; each state renders its named
copy; the copy control and `role="status"` announcement; the blocked (§4.1)
notice; a `tab-bar` regression case proving no second strip was introduced.

**Playwright**, headless against `http://localhost:5455` per `AGENTS.md` →
"Verification": Organization → Members → Automatic logins and Team → Members →
Automatic logins both render and screenshot; claim a domain and see the DNS
instructions; a verified domain's team checkboxes save; the activation confirm
dialog appears; backfill status renders; keyboard-only traversal of the tab
strip and the checkbox group; and a non-admin session sees no management
controls.

## 15. Rollout sequencing

1. **Probe UOA backend mode** (§4.2) against the configured instance and record
   the answer in this document. Everything below is written for either answer;
   only step 7 is conditional.
2. `packages/email-domain-policy` + vendored lists + verifier lint. No callers.
3. Migration + Prisma models + audit-action enum entries. Additive; nothing
   reads them yet.
4. API routes, service, DNS verifier — behind the instance flag, default off.
5. Worker: provision topic + handler, revalidation sweep. Sign-in enqueue added
   last in this step, so the queue consumer exists before any producer.
6. Admin: facade, panel, tab.
7. Backfill run model + job + status UI — **only if step 1 succeeded**.
8. Docs in the same turn: this plan moved toward `docs/done/` when complete,
   the 2026-08-20 plan marked superseded, and
   `docs/standards/team-model.md` given one routed sentence naming this feature
   as the one place Nessie policy decides team placement while UOA still owns
   the membership, plus `docs/functionality.md` and `AGENTS.md` → Architecture
   routing entries.

Deployment is backward-compatible at every step: new tables are unread until
step 4, the flag is off until an operator turns it on, and no existing rule is
ever inferred, created or activated by the migration. There is no data
backfill in the migration itself.

## 16. Non-goals

- Nessie does not authenticate anybody by domain, and no copy suggests it.
- Nessie does not write, change or remove a membership row of its own; every
  grant is a UOA relay and every removal stays explicit and manual.
- No org-level admission: a domain rule places existing organisation members
  into teams (C4); it cannot add a stranger to the organisation.
- No admin or owner role is ever granted automatically.
- Subdomains are never implied by a parent claim.
- No surface for local/no-IdP installations (`externalOrgId` null) or for
  generic-OIDC tenants.
- No broad list of matching people is shown to an administrator — counters only.
- No new tab framework, table, chip, dialog or progress primitive; §13 names the
  existing component behind every element.
