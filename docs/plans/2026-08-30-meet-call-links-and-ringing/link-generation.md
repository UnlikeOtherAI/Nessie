# Call links + ringing — link generation by team setting

This chapter continues the numbered design in [the overview](./overview.md).

## 3. Link generation — provider by team setting

### 3.0 The team setting

`Team.callProvider` — string column, `'google_meet'` (default) | `'jitsi'`
| `'microsoft_teams'`, on the `Team` model (`api/prisma/schema.prisma:1365`; the model has no
settings fields today, and there is **no team-update route** — only
`GET/POST /api/teams` + member add — so this ships with a new
`PATCH /api/teams/:teamId/settings`, org owner/admin-gated). Resolution at
call time: channel → its team → `callProvider`. The provider used is
stamped on the `Call` row, so a mid-flight settings change never mutates an
existing call. The setting is a **default, not a lockout**: the agent tool
may mint the other provider on the user's explicit request (§10) — it
carries the user's own Google authority either way. The human Call button
always follows the team setting (no per-call picker in v1; §12).

**Surface (Rule zero):** there is no team-settings page; per-team controls
live as rows on org-level pages (the Integrations page's per-team DeepWater
enablement is the precedent). Home: a **Calls** section on
`/settings/organization` listing each team with a provider select. In-context
doorway: the caller popup names the provider ("via Google Meet"), linking to
the setting for owners/admins.

The `createMeetingLinkForUser` seam (§3.4) becomes
`createCallLinkForTeamUser(prisma, {teamId, userId})`, dispatching on the
resolved provider — this is the provider seam §4 calls deliberately
provider-shaped, now with its second implementation. Everything downstream
(ring, accept, popup, state machine, shells) sees only a URL.

### 3.1 Meet API choice — Meet REST `spaces.create` (chosen)

`POST https://meet.googleapis.com/v2/spaces` with the user's OAuth bearer
returns `{ name, meetingUri, meetingCode, config }` — an instant link
(`https://meet.google.com/xxx-yyyy-zzz`), no calendar event. Scope:
`https://www.googleapis.com/auth/meetings.space.created` — the narrowest
Meet scope, but stated precisely: it allows creating **and managing
(reading/modifying) spaces this app created** — not "create-only" — and
Google classifies it **Sensitive**, so adding it to the production consent
screen requires justification + verification **before** deployment, a
pre-deployment gate rather than a maybe-follow-up (§3.5). Works for
consumer Google accounts and Workspace alike.

Rejected: Calendar `events.insert` + `conferenceData.createRequest` — needs
the far broader `calendar.events` write scope and leaves an event on the
user's calendar per ad-hoc call. Revisit only if scheduled meetings with
invitations become a goal.

Space config: `accessType: OPEN`, so recipients join from the link without
Google-side invites (they may not have Google accounts). The link is a
capability; accepted tradeoff recorded in §12 (parity with today's
public-Jitsi rooms, which are strictly worse — guessable names).

### 3.2 Whose Google account (Meet teams only)

**The initiator's.** Minted under the caller's per-user Google
`CommsConnection` (Individual Communications Connector). For the agent tool,
the initiator is the **run's requesting user** (§10). No org-level service
account. A user without a Google connection gets a typed refusal and the
existing connect path (`/settings/connections`, or the PA's
`comms_connect_card`). Teams set to `jitsi` never touch Google — no
connection, no scopes, no refusal states (§3.6).

### 3.3 OAuth scope — new connections and re-consent

Today's Google comms config requests `gmail.readonly openid email profile`
(`api/src/routes/comms/oauth-config.ts:51`; PKCE, `access_type=offline`,
`prompt=consent`). Changes:

- Add `https://www.googleapis.com/auth/meetings.space.created` to the scope
  list and `include_granted_scopes=true` to `extraParams`, so re-auth is
  incremental.
- The credential already records `grantedScopes`
  (`packages/comms-google/src/connector.ts:73`); the link service checks for
  the Meet scope **before** calling Google and returns typed errors —
  `GOOGLE_NOT_CONNECTED` vs `MEET_SCOPE_MISSING` vs
  `GOOGLE_REAUTH_REQUIRED` — so the UI/PA names the exact fix and links the
  same OAuth start route. No silent escalation; the user re-consents.
- Token refresh and `needs_reauthorization` handling reuse the comms
  credential machinery unchanged (encrypted `CommsConnectionCredential`).

**First use, concretely:** a caller who has never connected Google clicks
Call → the popup renders the `GOOGLE_NOT_CONNECTED` state with a Connect
button → the standard comms OAuth flow (now carrying the Meet scope) → back
in the popup, Call retries. One-time per user.

**Design decision (flagged):** extend the *comms* Google connection rather
than adding a second Meet-only Google link. One Google identity per user,
additive scopes, existing connect UX. Cost: the so-far read-only comms
connector gains one create-only action scope (§12.6).

### 3.4 Where the code lives

- Meet HTTP client (space create) in **`@nessie/comms-google`** beside the
  Gmail client — it owns Google HTTP already. Outbound via `safeFetch` per
  the egress rule; bearer headers and provider bodies carrying token
  material are never logged.
- **A shared, DB-aware credential coordinator — correcting an earlier
  draft:** `@nessie/comms-connect` deliberately has **no Prisma
  dependency** (interfaces + crypto only), and today the API and worker
  each hold their own copy of credential decryption
  (`api/src/routes/comms/context.ts`,
  `worker/src/control/comms-persistence.ts`). The link service must not
  become a third copy: the coordinator (new db-aware module, home decided
  at implementation — beside the existing two so they can converge on it)
  loads the owned connection, decrypts narrowly, refreshes with
  concurrency control, **preserves the stored refresh token when the
  provider omits a replacement** — fixing the existing defect where the
  reconnect upsert writes `refreshTokenCiphertext: null` unconditionally
  (`api/src/routes/comms/persist.ts`) — persists expiry/scope changes, and
  atomically marks `needs_reauthorization`.
- **Which connection:** the schema allows several Google connections per
  user (uniqueness includes external tenant/user ids). v1 uses the single
  active connection holding the Meet scope; several qualifying → the most
  recently authorized, and the popup names the account. The OAuth callback
  today lands on `/settings/connections`; the connect-from-popup flow
  carries a **return intent** so re-consent resumes the call popup instead
  of stranding the caller in settings.
- Call orchestration (`startCallForUser`: mint + `Call`+`CallInvite` rows +
  ring kickoff) in **`@nessie/workspace-admin`**, re-exported by
  `api/src/services/calls.ts` — because the worker tool must call the same
  function and `api/src/services/*` is unreachable from the worker (the
  provisioning-tools precedent).

### 3.5 Google Cloud project setup (deployment prerequisite)

One-time, per deployment (the production Google OAuth client):

- Scriptable with `gcloud`: project selection and
  `gcloud services enable meet.googleapis.com`.
- **Not scriptable**: the OAuth consent screen for an *external* app and the
  standard web-application OAuth client id/secret have no public API —
  `gcloud`'s OAuth surfaces (`iap oauth-brands`/`oauth-clients`) cover only
  internal IAP brands. Creating/updating the consent screen (add the Meet
  scope to the declared scopes) and the web client stays a Cloud Console
  step, documented in `docs/deployment.md`.
- Output lands in the existing env: `NESSIE_COMMS_GOOGLE_CLIENT_ID` /
  `..._SECRET`. Publishing status: an external consent screen in "testing"
  caps at 100 test users and expires refresh tokens after 7 days —
  production must be "in production" (the Meet scope is non-sensitive-ish
  but Gmail readonly already forces Google verification; that verification
  burden exists today and does not change materially).

### 3.6 Jitsi as a link provider (team opt-in)

A team set to `jitsi` mints
`https://${NESSIE_JITSI_DOMAIN}/nessie-<128-bit base32 random>` — pure URL
construction, no OAuth, no network call, no per-user setup. Notes:

- `NESSIE_JITSI_DOMAIN` (default `meet.jit.si`) replaces the client
  hard-coded constant (`admin/src/lib/jitsi.ts:3`) server-side; a
  self-hosted Jitsi is just a different domain.
- The cryptographically random room id retires today's guessable
  `nessie-<8 hex of channel uuid>-<hex ms>` naming — on a public Jitsi
  server the room name **is** the access control, so this matters.
- Same capability semantics as an OPEN Meet space: whoever holds the link
  joins. Same ring flow, same tab-open, same state machine.
- The call still happens in a separate tab on the Jitsi page — the embedded
  iframe/overlay is **not** retained for jitsi teams.

### 3.7 Microsoft Teams as a link provider (team opt-in)

Microsoft Graph `POST /me/onlineMeetings` (scope `OnlineMeetings.ReadWrite`)
returns a `joinWebUrl` — the same shape as a Meet mint: created under the
**initiator's** Microsoft connection. The comms connector already plans a
Microsoft provider (`CommsProvider` includes it; the adapter package and the
`NESSIE_COMMS_MICROSOFT_*` OAuth config are the unbuilt half), so the Teams
mint rides that connection exactly as Meet rides Google — typed
`MICROSOFT_NOT_CONNECTED` / `TEAMS_SCOPE_MISSING` refusals, encrypted
credential bundle, same `needs_reauthorization` semantics. The team setting
only offers `microsoft_teams` when the deployment has the Microsoft OAuth
provider configured (an unconfigured provider is unselectable, named in the
UI — never a dead toggle, per the trigger-health precedent). **Sequencing
decision for the owner (§12.10):** the Microsoft comms connection is real
work (Azure AD app + adapter package); v1 can ship Meet + Jitsi with the
provider seam and setting already three-valued, Teams landing with the
Microsoft connector — or the Microsoft OAuth leg gets pulled forward. The
seam and the ring flow are identical either way.

