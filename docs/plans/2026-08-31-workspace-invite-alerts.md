# Workspace invitation alerts (2026-08-31)

## Flow

UOA remains the authority for workspace invitations. A successful `GET
/org/me` directory read returns both active workspaces and the caller's pending
invitations. Nessie caches that verified result in memory and reconciles each
pending invitation into one durable `workspace_invitation` user alert.

The workspace switcher owns the invitation list. The alerts bell and `/alerts`
provide the second, attention-driven doorway. Both use the same client action:

1. `POST /api/workspace/invitations/:inviteId/accept` relays acceptance to UOA
   in backend mode for the authenticated user's live `User.uoaSub`.
2. On success, the API deletes the matching alert.
3. The client calls the existing UOA workspace-switch path with the accepted
   organisation and team, then enters `/channels`.

There is no owner gate. Accepting one's own invitation is a member-level
self-action, while UOA validates that the invitation belongs to the subject.

## Alert lifecycle

The alert event key is `workspace-invite:<inviteId>`, unique per user. Every
verified directory read upserts the current set and deletes invitation alerts
that disappeared because they were accepted, revoked, or expired. A failed or
unavailable directory read performs no reconciliation: `undefined` means
unknown, not verified-empty.

Invitation alerts are deleted rather than marked read. Their metadata is
UOA-owned transient invitation state and must not linger after UOA stops
returning it. The alert's local `organizationId` moves to the organisation in
the caller's most recent session so the bell they are viewing can show this
user-scoped invitation. Its metadata retains the target UOA organisation and
team ids needed by acceptance.

Visibility does not revalidate a local relation to the invited workspace:
there cannot be a membership relation before acceptance, and UOA owns the
invite. Reconciliation on verified login and token-rotation reads supplies the
freshness boundary; the alert query's outer active-membership condition still
requires the caller to be active in the local organisation where the alert is
shown.

## UOA contract consumed

`GET /org/me` supplies:

```text
org.pending_invites[] = {
  inviteId,
  orgId,
  teamId,
  teamName,
  invitedBy: string | null,
  expiresAt: ISO string | null
}
```

Acceptance uses domain-hash bearer authentication without an
`X-UOA-Access-Token` header:

```text
POST /org/organisations/:orgId/teams/:teamId/invitations/:inviteId/accept
{ "userId": "<uoa subject>" }
```

A readable `200 { ok: true, orgId, teamId }` is success. A `400` carrying
`ORG_CONFLICT_ON_DOMAIN` becomes Nessie's `409 INVITATION_ORG_CONFLICT` with an
actionable explanation. Other UOA 4xx responses become
`INVITATION_NOT_ACCEPTABLE`; UOA unavailability becomes `503`.
