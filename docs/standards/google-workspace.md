# Google scopes, capabilities and send approvals

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **A provider scope is a capability in one catalog, and every check on it
  fails closed.** Google's scopes live in
  `packages/schemas/src/google-capabilities.ts` and nowhere else. Three fixes
  make the checks trustworthy, each closing a real fail-open: `grantedScopes`
  is read from the token response and a response with no `scope` is refused
  (it used to fall back to the *requested* scopes, recording authority a
  person had un-ticked on the consent screen); account identity comes from the
  OIDC `id_token`, not Gmail's `users.getProfile`, which needs a Gmail read
  scope and therefore made a calendar-only or send-only connection impossible;
  and HTTP 403 is classified by Google's machine reason, so
  `insufficientPermissions` is fatal and surfaces as a request to grant the
  capability instead of retrying until the job dies. Capability checks are
  all-of at the one `loadUserGoogleCommsCredential` chokepoint, which also
  enforces local blocks and refuses two qualifying accounts rather than
  guessing. A local block is not a revocation — a provider grant can only be
  revoked whole — so it is enforced server-side and the copy says so. OAuth
  state binds the connection being widened and the expected provider account,
  because a callback that trusts whoever finished consent will silently
  re-point a different mailbox. Plan:
  `docs/plans/2026-08-31-google-workspace-email-calendar.md`.
- **An approval over provider content binds the content, not its handle, and
  the gate is code rather than data.** Hashing a Gmail draft's *id* authorises
  nothing useful: the draft stays mutable through the chat card, through Gmail,
  and through another run, so an approved send could deliver text nobody
  approved. The authorization chokepoint reads the server-owned
  `GmailDraftAction.contentFingerprint` into the canonical proof arguments
  (never from model input), and `sendDraftForUser` re-reads and compares it on
  every send path. Its attachment input includes Gmail's immutable
  `attachmentId`, MIME type, filename and size; when Gmail returns inline bytes
  instead, it includes a server-only hash of those bytes. Provider identifiers
  and hashes never enter cards, API payloads or audit records. The same row
  carries the conditional `draft → sending → sent` claim that makes a double
  send impossible. The
  approval requirement itself is declared on the tool definition and enforced at
  the tool chokepoint, because `evaluateToolInvokePolicy` defaults to `allow`
  and a seeded-`PolicyRule` gate is therefore absent in any organisation whose
  seed never ran. Its only bypass is an exact-key standing grant
  (`SendAuthorizationGrant`, `(connectionId, agentId)`, the
  `ScopeDisclosureGrant` shape) that never covers an unattended run or a
  non-owner, and `ApprovalRequest.requiredApproverUserId` keeps a send-as-you
  gate resolvable only by the person it acts as — approval visibility otherwise
  reaches every member who can read a public channel. One shared
  `sendDraftForUser` serves the human button and the agent tool; api services
  are unreachable from the worker, so a second copy forks the state claim and
  the audit trail on day one. The draft's exact content may enter the authorized
  run and the server-owned frozen proof arguments, but never approval context,
  ToolCall history, thinking/realtime status, demonstrations, connector
  telemetry, or audit metadata; those operational records name only the action
  and outcome. Unknown provider failures are mapped to a stable support code,
  never rethrown into those sinks. Details: `CLAUDE.md` → the Google bullets.
