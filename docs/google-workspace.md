# Google Workspace in Nessie

The operational detail behind `CLAUDE.md` → "Google scopes are a capability
catalog". The invariants themselves are in `AGENTS.md`; this file carries
the facts that live nowhere else. Split out of `CLAUDE.md` when that file
reached its structure-lint cap.

### Google scopes are a capability catalog, and the checks fail closed

`packages/schemas/src/google-capabilities.ts` is the single source of truth for
which Google scopes Nessie may request, what each lets an agent do, and its
verification tier. Never hardcode a Google scope anywhere else, and never
derive a capability from a raw scope string at a call site. Plan and phasing:
[docs/plans/2026-08-31-google-workspace-email-calendar.md](docs/plans/2026-08-31-google-workspace-email-calendar.md).

- **`grantedScopes` is what Google returned, never what we asked for.** A
  person can un-tick individual scopes on the consent screen, so the token
  response is the only truthful account of the grant. `connect()` refuses a
  response carrying no `scope` rather than falling back to the request — the
  fallback that used to be there recorded authority the user had declined.
  *Refresh* keeps a fallback to the stored scopes, where an omitted `scope`
  genuinely means unchanged.
- **Identity comes from the OIDC `id_token`, never Gmail.**
  `users.getProfile` requires a Gmail read scope, so a calendar-only,
  send-only or Meet-only connection could not be established at all while
  identity came from it. `openid email profile` is requested on every connect
  for this reason; issuer, audience and expiry are validated, and Google's
  stable `sub` is stored as `CommsConnection.providerAccountId`.
- **403 is two different failures.** Google reuses it for rate limiting and for
  insufficient scope. Only the rate-limit reasons retry; `insufficientPermissions`
  is fatal and flagged `scopeMissing`, so a missing scope can surface as a
  request to grant it instead of looping until the job dies.
- **Capability checks are all-of, at the one chokepoint.**
  `loadUserGoogleCommsCredential` takes `requiredScopes` (every one must be
  granted — `contacts.read` needs two), enforces `disabledCapabilities`, and
  refuses `AMBIGUOUS_ACCOUNT` when two of a user's Google accounts qualify
  rather than silently taking the most recently updated one.
- **A local block is not a revocation.** Google's `/revoke` kills a whole
  grant, so removing one capability is a local gate enforced at the chokepoint;
  the UI says "blocked locally — Disconnect to revoke at Google" and must not
  claim otherwise.
- **A composed email is a durable row whose CONTENT an approval binds.**
  Rule and rationale: `AGENTS.md` → "An approval over provider content binds
  the content". Facts not restated there: `sendDraftForUser` holds a consented
  send for `NESSIE_GMAIL_UNDO_WINDOW_MS` (default 15s) so the card can offer
  Undo, and a worker sweep dispatches it when the window elapses — without the
  sweep a held send would sit in `sending` forever. A provider failure returns
  the row to `draft` so the person keeps an affordance.
- **The draft card carries identifiers only.** Message metadata is readable by
  everyone who can read the message, and a *dictated* draft involves no read at
  all — so the run basis would be empty and the message unrestricted. The card
  stores `{ draftActionId }` and fetches recipients, subject and body from an
  owner-gated route that 404s indistinguishably; every mailbox card stamps the
  owner's basis explicitly rather than relying on the run having read anything.
- **OAuth state binds its target.** The state row carries the connection being
  widened, the expected provider account and the requested capabilities; the
  callback refuses `account_mismatch` when a different Google account completes
  consent, instead of silently re-pointing that mailbox. A first connect forces
  `prompt=consent` so Google issues a refresh token; an incremental add does
  not, and asks for the union of current and new scopes so a grant never
  narrows.

