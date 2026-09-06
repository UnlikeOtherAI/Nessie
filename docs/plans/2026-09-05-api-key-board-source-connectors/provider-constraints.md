# Expiry, egress, declared capabilities and Asana

Part of [the API-key connector design](overview.md).

## 6. Expiry — Jira's, and the state that names it

### 6.1 The rule in `loadBoardSourceConnectionContext`

```
if connection.status === 'expired'                     → { error: 'CREDENTIAL_EXPIRED' }
if connection.status !== 'active'                      → CONNECTION_NEEDS_REAUTHORIZATION (existing)
if scope === 'personal' and owner inactive             → OWNER_INACTIVE (existing, personal only)
if expiresAt and refreshToken and authMethod === 'oauth' and within 5 min
                                                       → refresh (existing, unchanged)
if expiresAt and no refreshToken and expiresAt <= now  → set status 'expired', CREDENTIAL_EXPIRED
```

A credential with an expiry and nothing to refresh it with is a different
thing from one whose refresh failed, and it gets a different word. The worker
maps `CREDENTIAL_EXPIRED` to health `credential_expired`, reason
`CREDENTIAL_EXPIRED`, through the same `failSource`/`claimHealthTransition`
path as the other two credential states (`board-source-sync.ts` 85–94), so it
alerts once per transition like everything else.

### 6.2 Ahead of the date

A daily worker pass, `board-source.credentials.expiry`, beside the existing
webhook renewal (`board-source-webhooks-renew.ts` is the model — same
`BoardSourceSyncDeps`, same interval registration in `worker/src/index.ts`):

1. Connections with `status: active`, `expiresAt <= now + 7 days` and no
   refresh token: write one `UserAlert` per steward with a new kind
   `board_source_credential_expiring`, `eventKey =
   'board-source-credential:<connectionId>:<expiresAt ISO>'`, `boardSourceConnectionId`
   set. The event key carries the expiry, so a rotated key (new date) alerts
   again once and the old alert stops surfacing through `visibleUserAlertWhere`
   when the connection's `expiresAt` moves. Recipients: `personal` → the owner;
   `project` → that project's administrators; `organization` → the
   organisation's active owners — the same `healthAlertRecipients` shape
   (`board-source-health.ts` 75–112) keyed on the connection's scope.
2. Connections with `expiresAt <= now`: `status: expired`, audit
   `board_source_connection.expired`, and `claimHealthTransition(credential_expired)`
   on every source naming it — so the board says *expired* on the date rather
   than *the provider stopped accepting this* an hour later.

The alert's deep link is the connection's home (§10.1) with the rotate form
open. Push goes under the existing `pushBoardSourceHealth` preference; the
body is generic (*"A project tool key expires soon"*), cause behind the link,
as the health standard requires.

### 6.3 On the surface

The Connections row shows `Expires 12 Oct` in the neutral tone, `Expires in 5
days` in warning, `Expired` in danger with *Replace key* as the row's action.
`SourcesSettingsSection` gains the `credential_expired` row:

| state | sentence | remedy |
|---|---|---|
| `credential_expired` | *Its key expired on 12 Oct* | **Replace key** → rotate form in a `Dialog` |

and the `reconnect` remedies that today render no button (T12) become real
ones: `needs_reauthorization` → *Reconnect* (OAuth popup) or *Replace key*
(pasted), chosen by the connection's `authMethod` which `BoardSourceRecord`
gains as `connectionAuthMethod`; `owner_inactive` → *Connect as me* opens the
dialog at step 1 with the source pre-selected for re-pointing.

### 6.4 GitHub and the rest

GitHub fine-grained tokens expire; the person is not asked for the date. The
adapter reads the `github-authentication-token-expiration` response header on
`verify()` (and on every sync, updating `expiresAt` when it changes) — if that
header is confirmed at build time. If it is not, GitHub behaves like Linear
and Asana: no stored expiry, and a dead token is `CREDENTIAL_REJECTED` with
*Replace key*. Either way no provider other than Jira asks a person to type a
date.

## 7. The SSRF surface: Jira's site URL

This is the only place in the feature where a person types a host that a
worker will later dial with a credential attached. Everything else is a vendor
constant.

**Constrain the host class.** Jira Cloud sites are `https://<name>.atlassian.net`.
`parseJiraSiteUrl(input)` in `board-source-jira/src/auth.ts` accepts a string,
requires `https:`, lowercases the hostname, requires it to match
`^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.atlassian\.net$`, refuses any port,
userinfo, query or fragment, strips a trailing `/`, and returns the canonical
`https://<name>.atlassian.net`. Anything else is `VALIDATION_ERROR` with the
copy *"Enter your Jira site as https://your-team.atlassian.net"*. The result
is what `verify()` dials and what is stored in `credentialParams.siteUrl`.

**Validate at use time as well as write time** (the egress standard's rule for
inference `baseUrl`). `hostPolicy` for Jira is
`{ exact: ['api.atlassian.com', 'auth.atlassian.com'], suffixes: ['.atlassian.net'] }`;
`sourceFetch` matches a suffix only at a label boundary (`host === s.slice(1)
|| host.endsWith(s)`) so `evil-atlassian.net` and `atlassian.net.evil` fail.
The adapter re-runs `parseJiraSiteUrl` on `ctx.params.siteUrl` before composing
any URL, so a corrupted row cannot be dialled either.

**What remains and why it is acceptable.** After both checks, the worker
dials a hostname under a suffix Atlassian owns, resolved once and pinned by
`resolveVettedAddresses`/`pinnedLookup` (T10), which refuses any private,
loopback, link-local or metadata address the name resolves to — so an
`atlassian.net` subdomain pointing into the deployment's network is refused
by the guard the standard exists for — and with `maxRedirects: 0`, so a site
that answers 302 (a renamed tenant) fails closed instead of carrying the
credential to a host nobody vetted. The credential is sent to at most one
host, the one the person named, under the vendor's own domain. This is the
same trust class as `api.linear.app`.

**What is out.** Jira Cloud custom domains and Jira Data Center are arbitrary
hosts. They need an operator-vetted allowlist (`NESSIE_BOARD_JIRA_HOSTS`) so
that the host class is again decided by someone who runs the deployment, not
by whoever can administer a project. §12 lists both; neither is a "later add
a flag", both are "later add a policy with an operator behind it".

Two smaller points in the same surface: the unofficial `/_edge/tenant_info`
endpoint is not called (not a documented API, and nothing needs the cloudId
under Basic auth); and the identity-link tenant for Jira becomes the site
hostname on **both** auth paths — the OAuth container already stores
`siteUrl` (`board-source-jira/src/adapter.ts` 168) — so a person mapped once
is mapped for that site however a source was connected. No live Jira identity
links exist to migrate (T13).

## 8. Capabilities are declared, and the worker reads them

### 8.1 Webhooks by method

| Method | `webhooks` | Who owns the secret | Where it is stored | `verifyWebhook` receives |
|---|---|---|---|---|
| Linear OAuth | `app_level` | the deployment (`NESSIE_BOARD_LINEAR_WEBHOOK_SECRET`) | env | `signingSecret` from env (via adapter config fallback, existing) |
| Linear key | `per_source` | us: minted and passed as `webhookCreate(input: { url, teamId, resourceTypes, secret })` — that `secret` input is to be confirmed at build; if Linear only *returns* one, store that instead | `BoardSource.webhookSecretCiphertext` | `signingSecret` opened from the row |
| GitHub OAuth | `app_level` | the deployment | env | env |
| GitHub key, repository | `per_source` | us: `POST /repos/{o}/{r}/hooks { config: { secret } }`; **skipped without a call** when `grantedScopes` lacks `repo`/`admin:repo_hook` on a classic token; attempted and treated as unavailable on 403 for a fine-grained token (permission undocumented) | row | row |
| GitHub key, Projects v2 | `none` | — (org hooks need `admin:org_hook`; not offered) | — | — |
| Jira OAuth | `per_source` | nobody signs; per-source URL token hash (existing) | `webhookTokenHash` | `tokenHash` (existing) |
| Jira key | `none` | — | — | — |
| Asana key | `per_source` | Asana, handed over in the handshake (§9) | row | row |
| Trello key | `per_source` | the Power-Up's `apiSecret` over `body + callbackURL` (existing) | env | `signingSecret = callback URL` (existing convention) |

`ensureWebhook` in the sync worker (`board-source-sync.ts` 217–251) reads
`adapter.auth[ctx.authMethod].capabilities.webhooks` and calls the adapter only
for `per_source`; the adapter returns `WebhookRegistration` with an optional
`secret`, which the worker seals into `webhookSecretCiphertext`. The webhook
worker opens it and passes `{ signingSecret, tokenHash }`; the adapters'
existing `secrets.signingSecret ?? config.webhookSecret` (T7) then does the
right thing for both methods without a branch.

### 8.2 Freshness the surface can state

Each source row's freshness line is composed from declarations, never from
what happened: *webhook + 5-min poll* (`per_source`/`app_level` registered),
*polling every 5 min* (`none`, or `per_source` that returned null), and for
Trello *re-reads the board every 5 min* (`delta: 'rescan'`). The connect
dialog shows the same line under each provider so a person picking Jira by
key knows it will be up to five minutes behind before they pick it.

### 8.3 One tenant-key declaration

`identityTenantKey(container, connection)` on the adapter replaces the two
`if` chains (T7): Jira → site host from `container.siteUrl`; Linear →
`connection.externalTenantId`; Asana → `container.workspaceGid`; GitHub and
Trello → the provider name. `loadIdentityLinks` callers in both workers call
it.

## 9. Asana, as the fifth adapter

`packages/board-source-asana/` in the mould of the others: `adapter.ts`,
`auth.ts`, `normalise.ts`, `queries.ts` (the `opt_fields` constants).

- **Identity and tenants.** `GET /users/me` returns `workspaces[]`;
  `externalTenantId` stays empty and each container carries
  `{ workspaceGid, projectGid }` — the Jira-OAuth shape, since one PAT spans
  workspaces.
- **Containers.** `GET /workspaces/{gid}/projects` per workspace, paged by
  `next_page.offset`; `hint` is the workspace name. Teams sit between
  workspace and project but a project is the board; teams are not offered.
- **Describe.** Sections (`GET /projects/{gid}/sections`) are the states —
  `suggestedCategory` from position (first → `todo`, last → `done`, others →
  `in_progress`), `review` empty until promoted, as every list-ordered
  provider does. Custom fields from `/custom_field_settings`: `enum → select`,
  `multi_enum → multi_select`, `people → user`, `text/number/date` direct.
  Members from `/workspaces/{gid}/users` with email for exact matching.
- **`opt_fields` is mandatory.** Every task read passes
  `opt_fields=gid,name,assignee.gid,assignee.name,assignee.email,due_on,completed,custom_fields,memberships.section,memberships.project,notes,permalink_url,modified_at,created_at`;
  without it Asana returns only `gid` and `name`, which would normalise into
  a board of titles. `permalink_url` is `NormalisedItem.url` — the link back
  to the original ticket. `memberships.section` (filtered to this project)
  is `stateId`.
- **Delta.** Initial phase pages `GET /projects/{gid}/tasks` with
  `modified_since` derived from `syncWindowDays` for completed items.
  Incremental phase uses `GET /events?resource={projectGid}&sync={cursor}`:
  - no cursor yet, or a 412 → the body's `sync` is the new cursor; the page's
    items come from `tasks?modified_since=<checkpoint.since>` instead, so the
    window that the expired token would have covered is re-read rather than
    skipped;
  - otherwise events (`has_more` → keep paging) name task gids; `fetchItems`
    re-reads them; a `deleted`/`removed` event whose re-read 404s is applied
    as `archived: true`.
  `sourceFetch` gains `acceptStatuses?: number[]`; the events call passes
  `[412]` and gets the response back instead of a `SourceHttpError`. The 412
  therefore never leaves the adapter, never reaches `handleSyncFailure`, never
  touches `consecutiveFailures`. A test feeds a 412 body and asserts the
  checkpoint advanced and no error was thrown.
- **Write (personal scope only).** `PUT /tasks/{gid} { data: { name, notes,
  due_on, completed } }` for title, detail, deadline and done; a **column
  move** is `POST /tasks/{gid}/addProject { data: { project, section } }` —
  a membership call, not a field. `applyChange` re-reads the task afterwards
  for the echo, since `addProject` returns an empty `data`.
- **Webhook handshake.** `ensureWebhook` calls `POST /webhooks { data: {
  resource: projectGid, target: <callback url with token> } }`. Asana
  synchronously POSTs to `target` with `X-Hook-Secret` and only returns 201
  once we echo it. So, before the worker calls `ensureWebhook`, it stores
  `webhookTokenHash` for the minted token (today it is stored *after*,
  `board-source-sync.ts` 232–241 — the order flips for every `per_source`
  method). The intake route, on a request whose provider is `asana` **and**
  which carries `X-Hook-Secret`, finds the source by `sha256(token)`, seals the
  header value into `webhookSecretCiphertext`, replies 200 with the same
  header, and enqueues nothing. Every other request keeps the enqueue-only
  path. A handshake for a token no source holds is answered 200 without a
  write — telling Asana "no" leaks nothing and costs nothing. Ongoing
  deliveries verify `X-Hook-Signature` = HMAC-SHA256(secret, raw body).
- **Rate limits.** 150/min free, 1 500/min paid, per token; 429 with
  `Retry-After` is the existing `SourceRateLimitedError`. Rejected requests
  still consume quota, so the adapter does not retry inside a page.

