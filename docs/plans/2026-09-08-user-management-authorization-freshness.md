# User management: authorization freshness

## Request admission

`authenticateRequest` now verifies UOA-bound sessions through the existing
signed-subject `GET /org/me` API before admitting each request. UOA checks the
credential epoch and the current organisation and active-team memberships. The
actor's organisation role comes from that response, so a demotion applies on
the next request even while the local JWT and compatibility membership row
still say owner. An upstream refusal fails closed; an outage returns a retryable
503. There is no additional durable projection or stale response cache.

Local-password sessions cannot enter a bound tenant. An account already linked
to a UOA subject cannot sign in with, or change, a retained legacy password even
when the deployment runs in local mode. Unbound local accounts retain their
existing password flow.

## Organisation role changes

The organisation roster now relays UOA's live
`permissions.orgRoleOptions` display model. It is absent or empty when UOA
does not grant `changeMemberRole`; Nessie supplies no fallback vocabulary. The
Members detail view therefore offers only roles UOA configured for that
organisation, excludes `owner`, and relays the selected non-owner role to UOA.
UOA validates the value and keeps ownership transfer separate from role edits.

## Remaining migration

This admission gate does not replace all product authorization. The existing
`ProjectMember`, `TeamMember`, and `OrganizationMember` projections remain a
known violation of the UOA authority target in the unification plan. In
particular, project administration still reads `ProjectMember.role`; rotating
a session projects only its active team's role. A demotion in another team can
therefore leave old project-admin rights until that team is selected again.
Removing team membership also does not delete independently held channel
memberships. Established realtime connections use local delivery entitlements
and need the same live UOA authorization basis at their periodic recheck.

The required follow-up is an API-backed entitlement resolver shared by request,
project, team, worker and realtime checks, with fresh UOA organisation/team
standing and only Nessie-specific project/channel grants stored locally. Map
resource teams by stable external IDs, never by the session's ambient team.
If caching is needed, use bounded in-memory freshness and fail closed on
revocation or upstream failure. Migrate existing grants by provenance before
dropping duplicate UOA membership/profile data; do not preserve a compatibility
identity store as the target architecture.

The permanent regression cases must cover a person holding two teams: demote or
remove them in the inactive team, then attempt its project administration and
read its private content from the still-active other-team session. Recheck an
already-open event stream after the same mutation. Ordinary successful invites
and successful role-write responses alone do not prove those access boundaries.
