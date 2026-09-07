# UOA-backed board-source identity mapping

## Decision requested

Approve replacing email auto-matching for UOA-bound organisations. The current
source matcher reads `OrganizationMember → User.email` from Postgres. `email`
is UOA-owned profile data, so that is a durable profile lookup rather than an
UOA-authorized directory read.

This proposal does not alter unbound installations. They keep their local
member-email matching because there is no UOA authority there.

## Target behaviour

For a UOA-bound organisation, the Sources People panel reads candidates from
UOA live. The API carries the current caller's UOA subject assertion to
`listOrganisationMembers` in
`packages/team-admin/src/uoa-org-members.ts`; the existing roster transport
then calls `/org/organisations/:orgId/members`. UOA decides whether the caller
may see addresses, membership and the returned identities.

The API compares provider and UOA email addresses only in that request. It
resolves a selected roster entry through its stable `uoaSub` to the existing
local `User.uoaSub` binding and writes the product-specific
`BoardSourceIdentityLink`. It never stores the roster email or invents a local
user for someone who has not materialized through a UOA login. Agents remain
explicit manual mapping targets because they are Nessie-owned principals.

The background attach, sweep and webhook paths do not query local email or call
the UOA roster without a current subject assertion. They apply existing
identity-link bindings only; a new provider person remains visibly unmapped
until somebody maps them through the live People panel. UOA unavailability
refuses a new mapping or suggestion in the bound path. There is no local-email
fallback or durable UOA-directory cache.

## Implementation boundary

1. Split `packages/team-admin/src/board-source-identity.ts` into the existing
   binding read/projection path and a caller-authorized suggestion resolver.
   Remove `OrganizationMember.user.email` from the bound resolver.
2. In `api/src/routes/board-sources/sources.ts`, pass the actor's current
   `uoaIdentity` and the source organisation's `externalOrgId` to the existing
   UOA roster seam. Return UOA roster candidates only for the current mapping
   request; do not persist them in a BoardSource response or job payload.
3. Resolve manual selections by `User.uoaSub`, after confirming the subject was
   present in the live UOA roster. Keep `BoardSourceIdentityLink.userId` as the
   Nessie product binding; it stores neither an UOA profile nor membership.
4. Keep the present direct local-member resolver exclusively behind
   `Organization.externalOrgId === null`. Tests cover both branches, revoked or
   unavailable UOA directory responses, and that worker sync has no UOA/email
   lookup.

This is an API-backed refactor with no compatibility copy. It should land
before removing the UOA `User.email` mirror in the wider identity migration.
