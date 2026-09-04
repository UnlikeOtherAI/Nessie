# Automatic team membership by verified email domain

Automatic logins grant a person **normal member access only after that person
has signed in through UnlikeOtherAI**. A domain is proof that an organisation
controls DNS; it is never an authentication factor and it never identifies a
person inside Nessie.

## Operational boundary

The feature is off by default. It needs all of the following before an
administrator can activate a rule:

- `NESSIE_AUTOMATIC_MEMBERSHIP_ENABLED=true`;
- a real deployed UOA adapter for fresh verified-domain attestations, snapshot
  paging of UOA subjects, idempotent service-scoped member grants, and
  operation-status reads.

Generic UOA credentials are not an adapter. Nessie currently has no documented
UOA endpoint for this adapter, so production readiness is deliberately false:
the UI cannot activate a rule and the worker cannot sweep one. In its absence Nessie refuses
activation and no local `TeamMember`/`OrganizationMember` row is written.
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
and a maintained, versioned consumer/disposable denylist are rejected. Creation
also requires the deployment-provided complete PSL artifact
(`NESSIE_AUTOMATIC_MEMBERSHIP_PSL` plus a version); there is no short fallback.

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
