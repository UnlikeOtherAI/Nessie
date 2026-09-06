# Nessie corporate-domain auto-enrolment surface

**Status:** Superseded (2026-09-04) by
[2026-09-04-automatic-team-membership-by-verified-domain.md](2026-09-04-automatic-team-membership-by-verified-domain.md).
This plan made Nessie a pure relay of a *UOA-owned* domain claim, gated on a
`corporate_domain_auto_enrolment_management` signed-config flag and an
`X-UOA-Management-Assertion`. UOA shipped none of it and no date was set, so
none of this ever reached code. The successor keeps the invariant this plan was
protecting — UOA owns and authorizes membership — while holding the policy
(which domain, which teams, DNS proof, audit, reconciliation) in Nessie. Kept
for the reasoning in "UOA remains the authority", which the successor follows.

**Original status:** Proposed
**Scope:** Nessie is a secondary owner interface for the UOA corporate-domain
auto-enrolment capability. The primary hosted interface remains UOA Auth.
**Dependency:** `UnlikeOtherAuthenticator/Docs/plans/2026-08-20-corporate-domain-auto-enrolment.md`
**Reviewed:** Kimix CLI, 2026-08-20

## Outcome

An owner can configure the same corporate email-domain access policy from
**Nessie → Settings → Organization → Automatic access**, without leaving their
day-to-day product. They can prove the corporate DNS domain, see its status,
and add or remove one or more UOA workspaces as automatic targets.

This is a second doorway, not a second system: UOA owns the domain claim, DNS
proof, rules, UOA organisation/team membership, enrolment transaction, and
authoritative audit. Nessie holds no persistent domain-rule, DNS-token,
membership, or invitation data. It relays a live, UOA-defined representation.

## Decisions

### UOA remains the authority

Nessie never creates an automatic email invitation and never infers a person's
eligibility from their email address. The server resolves the active Nessie
organisation's `Organization.externalOrgId` and calls the matching UOA
organisation endpoint. The external id must be non-null and map to the current
UOA-backed Nessie organisation; a local/no-IdP deployment receives no local
replacement surface.

The UI calls Nessie's own API only. Nessie uses its existing server-to-server
UOA backend channel (domain-hash bearer, signed config, `safeFetch`, DNS
pinning, 10-second timeout), with `X-UOA-Access-Token` absent. A browser never
receives a UOA user access token, a UOA backend credential, or an UOA refresh
token.

UOA's new domain-claim/rule endpoints must explicitly support an **attributed
backend-management** mode. It requires both existing
`org_features.backend_org_management: true` and the new, exact signed-config
flag `org_features.corporate_domain_auto_enrolment_management: true`; UOA must
refuse these endpoints to a domain-hash caller when either is absent. The
existing broad backend-management flag alone must not enable this higher-risk
policy surface.

Each Nessie mutation also carries a fresh, one-time
`X-UOA-Management-Assertion`, signed by Nessie's configured config-JWT key.
Its RS256 claims bind the UOA subject, exact external organisation, action,
request id/jti, expiry of at most 60 seconds, and the exact UOA endpoint as
audience. UOA verifies the issuer's current config JWKS and replay, then
re-resolves that subject's **live** UOA organisation membership and requires
`owner`. This preserves the primary UOA interface's live authorization even if
Nessie's local role projection has not refreshed yet. The browser receives
neither this assertion nor any UOA credential.

Nessie still requires a current user actor with projected `owner` before it
constructs the assertion, as an early local gate. It adds one of the defined
Nessie audit actions after every accepted mutation; UOA's audit records the
authoritative policy mutation separately.

### One UOA contract, two presentation layers

The two interfaces use the same UOA claim/rule contract. At minimum the UOA
read response must provide the claim's non-secret status, expiry, domain,
rule target ids, and display-safe target names, plus the current set of
eligible target teams for that organisation. The server must source this from
UOA on every settings read; Nessie must not rebuild the list from its local
team projection, which can be stale and is not UOA's team authority.

The only plaintext DNS TXT challenge appears once in the response to the owner
who begins or reissues verification. Nessie's React state may show/copy it for
that active screen, but it must not put it in the URL, local storage, analytics,
logs, or Nessie's audit chain. Refreshing the page re-reads only redacted UOA
state and may require reissue, just as in the UOA Auth interface.

UOA owns consistency when both interfaces are open: claim state, duplicate-rule
handling, verification expiry, rule eligibility, and idempotency are all
upstream decisions. Nessie invalidates its query after a successful mutation
and renders UOA's fresh response; it does not implement optimistic local state
or conflict resolution.

### A reachable Nessie home and doorways

The capability's home is a new owner-only route,
`/settings/automatic-access`, under the existing **Organization** group.

- Add a derived `automaticAccessManagement` capability to Nessie's authenticated
  session/bootstrap payload. The server sets it only for a UOA owner on an
  external-org-backed tenant when the exact management flag is present in the
  verified UOA config contract. `AdminSidebarNav` uses this field; it does not
  optimistically probe a policy read while rendering.
- Add **Automatic access** to `AdminSidebarNav` only when that derived
  capability is true.
- Add a compact **Automatic access** card/link on the existing
  `OrganizationSettingsPage`; it explains that new verified corporate accounts
  are added before their first workspace selection.
- Add the same in-context link in the UOA branch of `SettingsMembersPage`, near
  the existing invitation controls, because it answers the adjacent decision
  “should employees join automatically rather than receive individual
  invitations?”

All three doorways render the same route/component. Members and UOA admins do
not see it; direct navigation gives a generic `404`/forbidden response without
revealing policy state. The page identifies UOA as the authority but does not
invent a cross-product management link: the primary Auth surface remains
reachable through UOA's normal authenticated chooser until UOA publishes a
dedicated, documented management launch contract.

### Product behaviour

The page states its scope plainly: “Applies only when a new account completes a
verified registration; it does not add existing people or re-add removed
people.” A verified domain card shows its state (`pending`, `verified`,
`expired`, or `revoked`), DNS record instructions while a freshly issued
challenge is in memory, and selected workspaces.

An owner can:

1. enter an exact corporate domain to begin/reissue DNS verification;
2. verify DNS after publishing the TXT record;
3. add any UOA-eligible workspace to a verified domain; and
4. remove a target workspace or revoke a domain claim.

The page cannot create a UOA organisation/team, alter join policy, pick an
automatic role, bulk-enrol existing people, or edit the legacy
`registration_domain_mapping`. UOA offers eligible targets only when their
join policy permits this feature. If a target becomes ineligible, UOA is the
source of the clear status/error; Nessie displays it and provides the normal
workspace-settings doorway instead of changing policy itself.

## Relay and contract plan

1. **Extract the shared UOA backend transport before reusing it.**
   `@nessie/workspace-admin/uoa-org-roster.ts` currently owns a hardened
   backend-mode request implementation for roster/invitation calls. Split its
   URL construction, domain-hash auth, `safeFetch`/pinned egress, timeout, and
   response/error handling into a narrowly named reusable UOA organisation API
   client. Keep roster-specific parsing in the roster module. The new
   auto-enrolment client and the existing roster client then use the one
   transport rather than a parallel fetch implementation.
2. **Add typed shared contract, assertion signer, and upstream client.** In
   `@nessie/schemas`, add
   redacted UOA domain-claim, rule-target, eligible-team, and one-time
   challenge response schemas; add the five closed-enum Nessie audit actions:
   `organization.auto_enrolment_domain_requested`,
   `organization.auto_enrolment_domain_verified`,
   `organization.auto_enrolment_domain_revoked`,
   `organization.auto_enrolment_target_added`, and
   `organization.auto_enrolment_target_removed` (the request action covers
   both begin and reissue). In `@nessie/workspace-admin`, add the assertion
   signer and list, begin/reissue, verify, revoke, add-target, and remove-target
   calls against UOA's released endpoints. Accept no caller-supplied UOA
   organisation id; resolve it from the current Nessie organisation's
   `externalOrgId`.
3. **Add Nessie's thin organisation-level routes.** Register
   `GET /api/organizations/current/automatic-access`, `POST .../domains`,
   `POST .../domains/:claimId/verify`, `DELETE .../domains/:claimId`,
   `POST .../domains/:claimId/teams`, and
   `DELETE .../domains/:claimId/teams/:externalTeamId`. Validate bodies and
   path ids after the owner gate. Resolve the tenant `Organization` row's
   `externalOrgId` and prove the session team belongs to that tenant and maps to
   the same UOA organisation before calling upstream. Resolve the actor's UOA
   subject only server-side to mint the assertion. Return the UOA-defined
   redacted schema.
4. **Keep authorization and errors fail-closed.** No UOA configuration,
   external organisation id, or session-team/org mapping means `404
   ORGANIZATION_NOT_LINKED`; do not fall back to a local table. A missing
   management capability is `403 UOA_AUTOMATIC_ACCESS_UNSUPPORTED`, distinct
   from an absent linked organisation. A non-owner is refused before parsing or
   upstream access. UOA 4xx becomes a stable, non-enumerating
   `UOA_AUTOMATIC_ACCESS_REJECTED`; transport, 5xx, and malformed data become
   `502 UOA_AUTOMATIC_ACCESS_UNAVAILABLE`. Preserve UOA's detailed policy
   state only for the entitled owner who can already read it.
5. **Audit actions, not profile copies.** After an accepted upstream mutation,
   emit the matching Nessie audit action containing the local actor, request id,
   external UOA organisation id, UOA claim/rule identifiers, and operation
   kind. Exclude the plaintext challenge, user email, identity subject, and
   raw DNS token. This is deliberate new audit coverage for a UOA backend-mode
   relay; roster mutations do not establish a reusable audit precedent. A
   failed or ambiguous upstream result emits no success audit action.

## UI plan

1. Add `AutomaticAccessSettingsPage` and a small facade beside the existing
   organization/member settings facades. The query key is organisation-scoped;
   all mutations invalidate it only after UOA succeeds.
2. Render a short explanation, an empty state, claim cards, a DNS verification
   panel, selected-workspace chips, and an owner-confirmed revoke action.
   Reuse existing `SettingsPanel`, feedback, card, button, and form patterns;
   do not create a second settings shell.
3. The target-team picker uses UOA's eligible-team list and stable external
   team ids. It may display names supplied by UOA but never accepts an arbitrary
   text id or a locally derived team list. Selecting multiple teams is repeated
   UOA rule creation, refreshed after each success.
4. Show loading, unavailable, unsupported, pending-DNS, expired, verified, and
   revoked states. In the unsupported/local case, omit the navigation doorway;
   a bookmarked route explains only that automatic access is unavailable for
   this organisation, without offering a local substitute.

## Delivery order and verification

1. UOA first ships the verified claim/rule model, normal owner interface,
   endpoint schemas, and attributed backend-management contract. It must
   require both `backend_org_management` and
   `corporate_domain_auto_enrolment_management`, verify the management
   assertion's signature, exact audience, expiry and one-time `jti`, and
   re-resolve the named actor as a live UOA owner of the config-domain-mapped
   organisation. Its tests must cover absent-flag refusal, malformed/replayed/
   cross-route assertion refusal, and a backend caller that may manage only the
   config domain's mapped organisation.
2. After UOA accepts that new signed-config field, add it to Nessie's
   `buildConfigJwt`, derive `automaticAccessManagement` in the authenticated
   session/bootstrap response, then implement the extracted shared UOA
   transport, assertion signer/client, routes, schemas, audit actions, and
   Admin facade/page. Update
   `docs/deployment-modes-and-auth-spec/authentication.md`, `docs/brief.md`,
   `docs/functionality.md`, and UOA's corporate-domain plan so both repositories
   name the primary Auth interface and this secondary Nessie surface.
3. Test the shared client with a pinned-fetch fake: no `X-UOA-Access-Token`,
   correct domain/config query, no redirect following, payload parsing, 4xx,
   outage, malformed response, and challenge redaction. Test the management
   assertion's exact endpoint audience, UOA subject/org/action binding, short
   expiry, unique `jti`, and exclusion from browser/server logs.
4. Test Nessie routes for owner-only access before upstream calls, exact
   `externalOrgId` resolution, missing mapping/capability, no local fallback,
   UOA error mapping, and audit entries with no challenge or email. Test all
   target mutations against a stale/deleted UOA target response.
5. Test the Admin page and nav states; use headless Playwright at
   `http://localhost:5455/settings/automatic-access` to verify an owner sees
   all three doorways, can issue and copy a challenge, and sees a fresh target
   after mutation. Verify that an admin/member and local deployment cannot
   reach the management data.
6. Run the affected Turbo tests with `DATABASE_URL`, lint-gated root build and
   typecheck, then a controlled end-to-end smoke test: configure a verified test
   domain and two target UOA workspaces from Nessie, register a new test account,
   and confirm it reaches both workspaces through the ordinary UOA chooser.

## Non-goals

- Nessie does not store or verify DNS claims, issue automatic email invitations,
  or write UOA membership directly.
- Nessie does not expose this control to local/no-IdP installations or to UOA
  admins/members.
- This does not replace the UOA Auth owner interface or alter the separate
  nickname-addressed invitation plan.
