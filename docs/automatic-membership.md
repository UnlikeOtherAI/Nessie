# Automatic team membership by verified email domain

Automatic logins grant a person **normal member access only after that person
has signed in through UnlikeOtherAI**. A domain is proof that an organisation
controls DNS; it is never an authentication factor and it never identifies a
person inside Nessie.

## Operational boundary

The feature is off by default. It needs all of the following before an
administrator can activate a rule:

- `NESSIE_AUTOMATIC_MEMBERSHIP_ENABLED=true`;
- `UOA_AUTOMATIC_MEMBERSHIP_APP_KEY`, a dedicated `uak_` service key issued to
  Nessie by UOA; and HTTPS UOA settings (`UOA_BASE_URL`, `UOA_DOMAIN`,
  `UOA_CONFIG_URL`, `UOA_JWKS_URL`, `UOA_REDIRECT_URL`,
  `UOA_CONFIG_JWT_PRIVATE_KEY_B64`, and `UOA_CONFIG_JWT_KID`).

Generic UOA credentials are not sufficient. The API and standalone worker use
the same fail-closed UOA adapter; when enabled without this key or its HTTPS
settings, a standalone worker exits with a configuration error and the API
refuses lifecycle changes. No local `TeamMember`/`OrganizationMember` row is written.
`NESSIE_AUTOMATIC_MEMBERSHIP_KILL_SWITCH=true` pauses future login grants and
backfill. It preserves existing access and audit evidence.

## DNS ownership lifecycle

An authorised administrator creates an exact-domain claim and receives a
cryptographically random TXT challenge at `_nessie-auto-access.<domain>`.
The raw challenge is encrypted at rest and is shown only when generated. DNS
verification moves a claim to `verified`; activation moves the access rule to
`active`. DNS rotation immediately suspends provisioning until the new record
is verified. Revalidation failure or expiry suspends provisioning without
removing members. Releasing/revoking a claim is explicit and audited.

Only precise domain matches qualify. Subdomains require separate claims. IP
literals, localhost/private pseudo-domains, malformed domains, public suffixes
and a maintained, versioned consumer/disposable denylist are rejected. It uses
pinned `tldts` public-suffix data with the versioned `free-email-domains` and
`disposable-email-domains` deny lists.

## Backfill and incident response

Activation and target changes create a generation-bound durable reconciliation
run. It pages an UOA snapshot in bounded batches, records per-team/subject
idempotency keys, and retries with backoff. A rule change supersedes earlier
generations. The worker rechecks the kill switch, current rule state, DNS
expiry, generation and target set immediately before each grant. No narrowing,
suspension, DNS failure, kill switch, or revocation removes a member.

The Automatic logins tab deliberately shows aggregate progress/failures rather
than a list of matching identities. The audit log has claim, DNS, lifecycle,
backfill and grant events but never stores email/profile values.

Interactive sign-in provisioning is deliberately bounded. It looks up a small
page of live claims through an indexed lifecycle query, re-attests the UOA
subject for each exact domain, and records the UOA member-grant idempotency key
before calling UOA. It never changes the team selected by the existing UOA
session, and provisioning errors are logged without failing that valid sign-in.
