# Automatic membership administration UI

The same `AutomaticMembershipRulesPanel` is the **Automatic logins** tab in
Organization Settings → Members and Team Members. The component is parameterized
by `organization` or `team`; no second tab implementation exists.

The panel consumes `GET /api/{organization|team}/automatic-membership` with:

- `featureEnabled`, `killSwitchEnabled`, and `permissions.manageRules`; the UI
  shows management controls only when the server says the caller may use them.
- Per-rule `capabilities` for lifecycle actions. A team administrator can
  verify, rotate, and activate that team's own unshared rule; controls for a
  claim shared with another rule are omitted when only an organization
  administrator can safely change it.
- Each rule's normal schema fields plus optional `dns`, named `targetTeams`, a
  single aggregate `backfill` summary, and a bounded `auditEvents` history.
  It must never include a matching-person directory or copied identity profile
  data.
  The query refreshes only while the aggregate backfill is queued or running.

Mutation endpoints are scoped identically: `POST` to create, `PATCH /:ruleId`
to change notification email or organization team mapping, then `POST`
`/:ruleId/{verify,rotate,activate,suspend,revoke,release}`. Organization team
choices are read from `GET /api/organization/automatic-membership/teams`.

Activation, suspension, revocation, and claim release each use the shared
confirmation dialog. Their copy makes explicit that these operations affect
future provisioning only and preserve existing memberships. DNS instructions
remain visible with their rule after creation or rotation; an authorization
email is labelled notification-only, never verification authority.
