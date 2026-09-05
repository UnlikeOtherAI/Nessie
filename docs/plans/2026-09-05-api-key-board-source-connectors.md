# API-key connectors for project board sources

**Date:** 2026-09-05 · **Status:** design, not yet built
**Owning surfaces:** Project → **Settings → Sources**
(`/projects/:projectId/settings?section=sources`) for the connect flow and for
project-scoped keys; the per-user **Connected accounts** page
(`/settings/connections` → *Project tools*) for personal keys; Organisation →
**Settings → Project tools** (`/settings/organization?tab=project-tools`, new
tab) for organisation-scoped keys.
**Extends:** [2026-09-05-project-boards-external-sources-and-custom-fields](2026-09-05-project-boards-external-sources-and-custom-fields/overview.md)
— its §5 adapter contract, §5.5 model and §5.10 health table are what this
document reshapes. Nothing built there is discarded.

The owner looked at the connect picker and it was empty: every provider is
gated on a per-deployment OAuth app nobody had registered. The ask is that a
person can connect Jira, Linear, Trello, GitHub or Asana by **pasting an API
key**, store that key at **project or organisation** level, see the account's
projects or boards, **pick several**, and have each one persist as a source
whose configuration — states, fields, people — is mapped onto ours, with every
mirrored task keeping a link back to the original ticket. OAuth stays wherever
a deployment has registered an app.

## 0. The one-paragraph version

`BoardSourceAdapter.oauth` stops being required and becomes one of two
**auth methods** an adapter declares under `auth: { oauth?, apiKey? }`; an
API-key method carries a **credential form** (the fields to render, where to
mint the key, whether it expires) and a `verify()` that turns pasted values
into the same `ConnectResult` OAuth produces, so the rest of the system never
learns how a credential was obtained. Each method also **declares its
capabilities** — whether it can register webhooks, and how — because they
differ by method (Jira has webhooks under OAuth and none under a token; Linear
and GitHub have app-level webhooks under OAuth and per-source ones under a
key). `BoardSourceConnection` gains a **scope** — `personal`, `project` or
`organization` — and `ownerUserId` becomes the personal scope's column only;
`ScopedSetting` is the wrong shape here and §4 says why. A **shared key is
read-only**; a **personal connection** (OAuth *or* a pasted key) may be
`read_write`, because what dissolves the attribution problem is that the
credential is one accountable person's, not that it came from an OAuth
redirect. Jira's mandatory token expiry becomes a stored date, a warning a week
ahead, and a `credential_expired` state whose remedy is *Replace key*, never a
failed refresh. Jira's typed site URL — the one caller-supplied host in the
feature — is constrained to `*.atlassian.net`, validated at write and use time,
and still dialled through `safeFetch`'s pinned, private-range-refusing
resolver. Trello has no API key without a Power-Up, so it stays
deployment-gated, but its token becomes a pasted credential like the others and
the fragment-callback path is deleted. Attach accepts **several containers at
once**, each in its own transaction, so three boards importing and one refusal
is the honest outcome. Asana arrives as the fifth adapter, its 412 sync-token
rotation handled inside the adapter where it is control flow, and its two-phase
webhook handshake completed by the intake route for a registration that is
still in flight.

## 1. What is true today

Established by reading code in the worktree at `2cfff393`, not assumed.

**T1 — `oauth` is a required member of the adapter contract.**
`packages/board-sources/src/adapter.ts` 110–118 declares
`readonly oauth: { buildAuthorizeUrl, exchange, refresh }`, and every consumer
reaches into it directly: `connections.ts` 113 (`buildAuthorizeUrl`), 142 and
238 (`exchange`), `board-source-credential.ts` 114 (`refresh`). An adapter
with no authorize URL cannot satisfy the type. `allowedHosts` (108) is a
static `readonly string[]` enforced by `sourceFetch` (`http.ts` 61–65) with an
exact-hostname `includes`.

**T2 — the picker is empty because registration is the OAuth env gate.**
`packages/board-source-providers/src/index.ts` 28–72 registers a provider only
when `NESSIE_BOARD_<VENDOR>_CLIENT_ID/SECRET` (or Trello's Power-Up
`API_KEY/API_SECRET`, 66–71) are set; `GET /api/board-sources/providers`
(`connections.ts` 41–49) returns `listRegisteredProviders()`; both
`ConnectSourceDialog.tsx` 114–117 and `ProjectToolConnections.tsx` 56 render
nothing or an operator-facing empty state when that list is empty.

**T3 — a connection is one person's, by schema and by gate.**
`api/prisma/schema.prisma` 1639 `ownerUserId String` NOT NULL; 1658
`@@unique([organizationId, ownerUserId, provider, externalAccountId, externalTenantId])`.
`loadBoardSourceConnectionContext` (`packages/team-admin/src/board-source-credential.ts`
55–62) refuses with `OWNER_INACTIVE` when the owner is no longer an active
organisation member, and `board-source-sync.ts` 88–92 turns that into the
`owner_inactive` health state. This is a deliberate revocation path: the sync
runs on delegated authority and deactivation must end it. `sources.ts` 64–71
(`CONNECTION_NOT_OWNED`) and `connections.ts` 317–326 (containers are listed
only for the owner) enforce the same rule at the routes.

**T4 — expiry means refresh, and a failed refresh is permanent.**
`board-source-credential.ts` 31–32: `needsRefresh` is true when `expiresAt` is
non-null and within `REFRESH_MARGIN_MS` (19, five minutes); 82–92 then calls
`refreshCredential`, which calls `adapter.oauth.refresh` (114) and on **any**
throw sets `status: 'needs_reauthorization'` (130–136). A credential with an
expiry and no refresh token — every Atlassian API token now — would be
refreshed five minutes before expiry, fail, and park the connection as
"needs re-authorization" with an OAuth remedy the provider does not offer. A
null expiry already works: `needsRefresh(null)` is false.

**T5 — credential storage is already shape-agnostic, one secret wide.**
`storeBoardSourceCredential` (139–157) seals `accessToken`, optionally
`refreshToken`, and stores `expiresAt`. `BoardSourceConnectionCredential`
(schema 1666–1681) has exactly those columns. Nothing stores a non-secret
parameter such as a site URL; `ConnectionContext` (adapter.ts 28–36) carries
none.

**T6 — attach is one container per call, with fields reused by name and type.**
`POST /api/projects/:projectId/sources` (`sources.ts` 118–222) takes
`{ connectionId, container, name? }` (`CreateBoardSourceBodySchema`,
`packages/schemas/src/board-sources.ts` 168–174), describes the container,
creates a project custom-field definition per external field unless one with
the same `name` **and** `type` exists (164–181), re-lists every container to
validate the one passed (183–197), creates the source and enqueues
`board-source.sync.initial` (216–220). `TaskFieldDefinition` is unique on
`(projectId, name)` (schema 1549) and `createTaskFieldDefinition` refuses a
taken name with `FIELD_NAME_TAKEN` (`task-fields.ts` 85) — so a second board
whose "Priority" is a *text* field where the first's was a *select* would today
fail the field step silently (the `'id' in created` check at 180 drops it) and
attach with that field unmapped.

**T7 — capabilities are discovered, not declared, and tenant keys are guessed
in two places.** `ensureWebhook` returns `null` for Linear (`board-source-linear/src/adapter.ts`
294) and GitHub (`board-source-github/src/adapter.ts` 366) because their
webhooks are app-level under OAuth; `verifyWebhook` in both falls back from
`secrets.signingSecret` to the deployment's `config.webhookSecret` (296–298,
368–370). The worker passes only `tokenHash` (`board-source-webhook.ts` 60), so
`signingSecret` is never supplied today. Which identity-link tenant a provider
uses is a provider `if` chain in `board-source-sync.ts` 207–215 and again,
duplicated, in `board-source-webhook.ts` 93–98.

**T8 — Trello's credential path is already a one-shot token post.**
`board-source-trello/src/adapter.ts` 42–75: `buildAuthorizeUrl` sends the
person to `trello.com/1/authorize` with the deployment's Power-Up key and
`response_type=token`; the token comes back in a URL fragment that
`callback-page.ts` 23–40 reads client-side and posts to
`POST /api/board-sources/connections/trello/complete` (`connections.ts`
215–275), where `exchange` proves it with `/1/members/me`. The design's own
comment calls this "the only plaintext credential path in the whole feature".
Trello's webhook signature (222–229) is HMAC-SHA1 with the Power-Up's
`apiSecret` over `body + callbackURL`.

**T9 — the intake route is deliberately dumb, and the sync engine classifies
by exception type.** `api/src/routes/board-sources/webhooks.ts` 31–55
enqueues and answers 202; `HEAD` answers 200 for Trello (23–29).
`sourceFetch` throws `SourceHttpError` for any status ≥ 400 (`http.ts`
101–103), and `handleSyncFailure` (`board-source-sync.ts` 253–333) increments
`consecutiveFailures` and backs off for anything that is not
rate-limit/cursor/auth/container-gone. An Asana `412` on `/events` would land
in that last branch.

**T10 — the egress guard is IP-pinned and private-range-refusing regardless of
the allowlist.** `packages/runtime/src/url-safety.ts` 25–73 blocks RFC 1918,
link-local, loopback, CGNAT, documentation and multicast ranges by literal
address; `resolveVettedAddresses` (101–110) refuses `localhost`, `.local`,
`.localhost` and the cloud metadata hostnames, resolves once, and
`pinnedLookup` (168–193) hands the socket only those vetted addresses.
`sourceFetch` adds `maxRedirects: 0` while a credential is attached (`http.ts`
91). `assertSafeUrl` is the same check without the fetch.

**T11 — the cascade standard has no project scope and secrets deliberately
live outside it.** `packages/runtime/src/scoped-settings.ts` 15:
`SETTING_SCOPES = ['organization', 'team', 'user']`; `docs/standards/scoped-settings.md`
says settings "walk *past* projects, not through them" and that secrets keep
their own table (`Secret`, schema 5510–5540, `scopeType` over
`organization → team → project → personal` with `locked`) while "stating the
rule once" in `packages/schemas/src/secret-precedence.ts`.

**T12 — the surfaces this lands on.** `SourcesSettingsSection.tsx` 24–34
declares a remedy per health state, but 125 hides the button whenever the
remedy is `reconnect`, so `needs_reauthorization` and `owner_inactive` show a
label and no doorway on the screen where the person is standing. The
organisation settings host (`OrganizationSettingsPage.tsx` 8–15) has two tabs,
*Profile* and *Agents*, behind `OrganizationAdministrationGate`. Health alerts
already render (`AlertRow.tsx` 52) and deep-link (`facades/alerts/hooks.ts`
186) for `board_source_health`. Audit entries are written through
`writeAuditEntry` (`packages/db/src/audit-chain.ts` 176) into the hash-chained
`AuditLog` (schema 4661).

**T13 — none of the four adapters has been run against a live vendor**
(`as-built.md` 43–62). The vendor facts below come from the September 2026
research pass over each vendor's own developer documentation; where that pass
marked something unverified, this document says so rather than deciding on it.

## 2. Decisions at a glance

| Question | Decision | Rejected | Why |
|---|---|---|---|
| How an adapter offers two ways to authenticate | `auth: { oauth?: OAuthMethod; apiKey?: ApiKeyMethod }`, at least one present; each method carries its own `capabilities` | `authKind: 'oauth' \| 'api_key'` flag with branches; two adapters per provider | A flag forces every consumer to branch on it; two adapters duplicate 90% of each vendor's parsing. Two optional method objects mean a route asks "does this provider have `auth.apiKey`?" and nothing else ever asks how a credential was born. |
| How the UI knows which fields to render | The API-key method **declares** `form: CredentialForm` (fields with `key`, `label`, `kind`, `help`; `createUrl`; whether an expiry is required) and the admin renders one generic form | Five hand-written forms; a JSON-schema form engine | One provider (Jira Cloud) has four fields, three have one; a generic renderer over five field kinds covers all of it in one component. JSON schema would be a form engine nobody asked for. |
| Who composes the stored credential | `verify(values)` on the adapter returns `credential` (sealed whole) and `params` (plaintext, non-secret); the route stores exactly those and never inspects raw values | Route seals fields marked `secret` and stores the rest | Jira's Basic credential is `email:token` — one credential made of two fields. The adapter knows that; the route must not. |
| Where a shared key lives | `BoardSourceConnection.scope ∈ {personal, project, organization}`; `ownerUserId` nullable and personal-only; `projectId` project-only; `createdByUserId` always | `ScopedSetting` rows; the `Secret` vault table; a new `BoardSourceSharedKey` table | A connection is not a value that *resolves* — a project uses several at once and a source names one explicitly — so there is no cascade to join (§4). The vault holds agent-facing secrets with grants and needs Infisical configured. A second table forks every route and worker that already takes a connection id. |
| A shared key's write authority | **Read-only, by policy at `updateBoardSource`.** `read_write` requires `scope: personal` — OAuth *or* a personal pasted key | Strictly "OAuth is the write path"; shared read-write with a "writes appear as X" banner | The owner's principle is attribution by construction. A personal API key is exactly as attributable as a personal OAuth grant (both act as one person at the vendor); a deployment with no OAuth app would otherwise have no write path at all. Options in §5. |
| Steward deactivation on a shared key | No gate; the connection keeps working, the steward's inactivity is shown on the row, and the vendor's own deprovisioning ends the token | Extend `OWNER_INACTIVE` to shared scope | A shared key exists so that one person leaving does not stop a board. The person who *authorised sharing* (an owner or project admin) is accountable; the row names both. Revocation is a button, not a side effect of HR. |
| Jira's mandatory token expiry | The person types the expiry from Atlassian's own screen; stored as `expiresAt`; alert 7 days ahead; on the date the connection goes `expired` and its sources `credential_expired` with remedy *Replace key* | Treat as `needs_reauthorization`; poll Atlassian for expiry | There is no API to read a token's expiry, and a state whose remedy is OAuth on a connection that has none is a lie. Re-authorization means "sign in again"; replacement means "paste a new key". Different button, different state. |
| Jira's typed site URL | Accept only `https://<name>.atlassian.net`, normalised, validated when stored and again when dialled; `hostPolicy.suffixes` replaces the exact allowlist for Jira only | Any URL the person types; an operator allowlist env | Jira Cloud sites live under `atlassian.net`, which turns "caller-supplied host" back into "vendor-owned host" — the same trust class as `api.atlassian.com`. Custom domains and Data Center need an operator-vetted host and are not in v1 (§8). |
| Trello | API-key method only, **deployment-gated** on the Power-Up key + secret; the person mints a token at the deployment's authorize URL and pastes it; `oauth`, `/trello/complete` and the fragment-reading callback are deleted | Drop Trello; ask each person to register a Power-Up | Trello has no key without a Power-Up and its webhook secret is the Power-Up's: the deployment prerequisite is a fact. Given it, the token *is* an API key, and pasting it is one fewer plaintext path than the fragment dance. Trello is the one provider that can still be absent from the picker, and the picker says why. |
| Capabilities | Declared per auth method: `webhooks: 'none' \| 'per_source' \| 'app_level'`; per provider: `delta: 'change_feed' \| 'updated_since' \| 'rescan'` and `identityTenantKey()` | Discover by trying; keep the worker's provider `if` chains | "A tool declares where it belongs; no surface guesses." The freshness line on a source row, the webhook-secret regime in the worker and the identity-link tenant are all read from declarations. |
| Per-source webhook secrets | `BoardSource.webhookSecretCiphertext`; the worker opens it and passes `signingSecret`; adapters already prefer that over the deployment secret | Reuse `webhookTokenHash` | A token hash verifies a URL token; an HMAC needs the secret itself. Linear and GitHub keys mint one per hook; Asana hands one back in its handshake. |
| Multi-select attach | `POST /api/projects/:projectId/sources` body becomes `{ connectionId, containers: [{ container, name? }] }` (1–20) → `{ created, refused }`; one transaction per container, sequential | A separate `/sources/batch` route; all-or-nothing | The dialog is the only caller and single-item is the degenerate case of plural. Rolling back three good imports because a fourth returned 403 punishes success; the refusal is reported by name. |
| Field collisions across boards | Reuse by `(name, type)`; for select types **union options by label**; a same-name different-type field becomes `<name> (<source name>)` and the response says so | Always create per-source fields; refuse the second board | A project-scoped field is what "one Priority across two boards" means (§2 of the parent design). A type clash cannot be unioned and must not fail silently as it does today (T6). |
| Asana delta | `/events?resource=<project>&sync=` inside `fetchPage`; a 412 is consumed by the adapter (new sync token, fall back to `modified_since` for that page); `sourceFetch` gains `acceptStatuses` | `modified_since` only | `modified_since` never reports a deletion, so a task deleted in Asana would stay on the board forever. The 412 is the vendor's normal token rotation and must never reach `consecutiveFailures`. |
| Asana webhook handshake | The intake route answers the handshake synchronously: looks the source up by its callback token, seals `X-Hook-Secret`, echoes it | Enqueue and hope | Asana holds the `POST /webhooks` open until the handshake completes; a queued job cannot answer in time. It is the one thing the intake route does beyond enqueueing, and it is gated on the header. |
| Rotation | `PUT /api/board-sources/connections/:id/api-key` re-verifies and replaces the credential in place; sources return to `active`; audit entry `board_source_connection.rotated` | A new connection + re-point every source | A shared key that ten sources name must be replaceable without ten edits. The account behind it may change (the steward left); the audit entry records the change of `externalAccountId`. |

## 3. The auth abstraction

### 3.1 The reshaped contract

```ts
// packages/board-sources/src/adapter.ts
export type BoardSourceProvider = 'jira' | 'linear' | 'trello' | 'github' | 'asana'
export type BoardSourceAuthMethod = 'oauth' | 'api_key'

export type ConnectionContext = {
  connectionId: string
  organizationId: string
  provider: BoardSourceProvider
  authMethod: BoardSourceAuthMethod
  externalAccountId: string
  externalTenantId: string
  credential: CredentialBundle            // unchanged: accessToken, refreshToken?, expiresAt?, scopes
  /** Non-secret values the adapter needs to address the vendor — Jira's siteUrl. */
  params: Record<string, string>
}

export type AuthMethodCapabilities = {
  /** How change notifications reach us under a credential obtained this way. */
  webhooks: 'none' | 'per_source' | 'app_level'
}

export type CredentialField = {
  key: string
  label: string
  kind: 'secret' | 'text' | 'url' | 'email' | 'date'
  help?: string
  placeholder?: string
}

export type CredentialForm = {
  /** Where the person mints the credential. Rendered as the link above the fields. */
  createUrl: string
  createLabel: string
  fields: CredentialField[]
  /** The vendor forces an expiry the person must copy across (Jira Cloud). */
  expiryRequired: boolean
}

export type PreflightNote = { code: string; tone: 'ok' | 'warning'; text: string }

export type VerifiedCredential = ConnectResult & {
  params: Record<string, string>
  /** Shown on the row: "acme.atlassian.net · jane@acme.com". Never a secret. */
  label: string
  preflight: PreflightNote[]
}

export type OAuthMethod = {
  capabilities: AuthMethodCapabilities
  buildAuthorizeUrl(input: { state: string; redirectUri: string; codeChallenge?: string }): string
  exchange(input: OAuthExchangeInput): Promise<ConnectResult>
  refresh(credential: CredentialBundle): Promise<CredentialBundle>
}

export type ApiKeyMethod = {
  capabilities: AuthMethodCapabilities
  form: CredentialForm
  /** Prove the pasted values against the vendor and identify the account. */
  verify(values: Record<string, string>): Promise<VerifiedCredential>
}

export type HostPolicy = { exact: readonly string[]; suffixes?: readonly string[] }

export interface BoardSourceAdapter {
  readonly provider: BoardSourceProvider
  readonly label: string
  readonly hostPolicy: HostPolicy
  /** Every provider polls as the floor; webhooks only make it faster. */
  readonly incrementalPollingIntervalMs: number
  readonly delta: 'change_feed' | 'updated_since' | 'rescan'
  readonly auth: { readonly oauth?: OAuthMethod; readonly apiKey?: ApiKeyMethod }
  /** The tenant one identity mapping covers. Replaces the worker's provider if-chains. */
  identityTenantKey(container: Record<string, unknown>, connection: { externalTenantId: string }): string
  listContainers / describeContainer / fetchPage / fetchItems / ensureWebhook / verifyWebhook / parseWebhook / applyChange  // unchanged signatures
}
```

What changed and why each change is the smallest one:

- `oauth` moved under `auth` and became optional beside `apiKey`. A provider
  factory returns `auth.oauth` only when constructed with a client id and
  secret; `auth.apiKey` whenever the vendor has a pasteable credential. Trello
  after this design has `apiKey` only; the other four have `apiKey` always and
  `oauth` when the deployment registered an app. The registry test asserts
  every registered adapter has at least one method.
- `ConnectionContext.authMethod` exists because two vendors change a header by
  it — Linear's API key is `Authorization: <key>` with no `Bearer`; Jira's
  token is `Basic`, its OAuth token `Bearer` — and because `ensureWebhook`
  registers per source under a key and nothing under an app. That is the only
  place adapters branch on it, in the function that composes headers.
- `ownerUserId` leaves `ConnectionContext`. Nothing in an adapter used it; a
  shared connection has none.
- `allowedHosts` becomes `hostPolicy` (§7). `sourceFetch` takes it in place of
  the array.
- `incrementalPollingIntervalMs` becomes required. It was optional with a
  15-minute default in the worker (`board-source-sync.ts` 199–200); every
  adapter already sets it, and under a token some providers have *only* this.
- `delta` and `identityTenantKey` are declarations for facts the worker and
  the UI were inferring (T7).

### 3.2 What the env gate becomes

`registerBoardSourceAdaptersFromEnv` registers **every** provider
unconditionally, passing OAuth config only when its env is present, and
registers Trello only when `NESSIE_BOARD_TRELLO_API_KEY/_API_SECRET` are set —
the one provider with a hard deployment prerequisite. It also returns the
providers it *could not* register with the reason, so the providers route can
show Trello greyed and named rather than absent:

```ts
GET /api/board-sources/providers →
[
  { provider: 'asana',  label: 'Asana',  methods: ['api_key'],          apiKey: { form, capabilities }, delta: 'change_feed',   pollingIntervalMs: 300000 },
  { provider: 'linear', label: 'Linear', methods: ['api_key', 'oauth'], apiKey: { … }, oauth: { capabilities }, delta: 'updated_since', … },
  { provider: 'jira',   label: 'Jira',   methods: ['api_key'],          apiKey: { … },                          delta: 'updated_since', … },
  { provider: 'github', label: 'GitHub', methods: ['api_key'],          apiKey: { … },                          delta: 'updated_since', … },
  { provider: 'trello', label: 'Trello', methods: [], unavailable: 'NEEDS_POWER_UP' },
]
```

`methods` is ordered with `api_key` first: the owner's decision that pasting a
key is the default connect path is expressed as list order, and the dialog
renders the first method's control as the default tab. The design's original
`containerKinds` field (api-and-contracts.md 52) was never built and is not
added.

### 3.3 The per-provider declarations

| Provider | `apiKey.form.fields` | `createUrl` | `expiryRequired` | `apiKey.capabilities.webhooks` | `oauth.capabilities.webhooks` | `delta` |
|---|---|---|---|---|---|---|
| **Asana** | `token` (secret) | `https://app.asana.com/0/my-apps` | no | `per_source` (handshake, §9) | — (no OAuth adapter in v1) | `change_feed` (`/events` sync token) |
| **Linear** | `token` (secret) | `https://linear.app/settings/account/security` | no (expiry policy undocumented — unverified) | `per_source` (`webhookCreate` per team) | `app_level` | `updated_since` (`updatedAt` filter) |
| **GitHub** | `token` (secret) | `https://github.com/settings/tokens` (classic; the help names the fine-grained URL too) | no (fine-grained tokens expire; the date is not entered — see §6.4) | `per_source` for repositories when the token grants `repo` or `admin:repo_hook`; `none` for Projects v2 | `app_level` | `updated_since` (`since`) |
| **Jira Cloud** | `siteUrl` (url), `email` (email), `token` (secret), `expiresAt` (date) | `https://id.atlassian.com/manage/api-tokens` | **yes** | `none` (poll only; webhook registration under Basic auth is undocumented and treated as unavailable) | `per_source` (unsigned, 30-day, existing) | `updated_since` (JQL `updated >=` with `nextPageToken`) |
| **Trello** | `token` (secret) | `https://trello.com/1/authorize?key=<deployment key>&name=Nessie&scope=read,write&expiration=never&response_type=token` — built by the adapter from its config | no | `per_source` (public callback required; HEAD probe) | — (deleted) | `rescan` (cards have no since; actions feed deletions) |

Help copy, field by field, is in §10.2. The credential each `verify()` stores:

- Asana, Linear, GitHub, Trello: `accessToken = token`, `params = {}`.
- Jira Cloud: `accessToken = "<email>:<token>"` — the exact string Basic auth
  base64-encodes — and `params = { siteUrl }`. The email is part of the
  credential and is sealed with it; it is never written to a plaintext column
  and never becomes a Nessie profile field (UOA rule). `externalTenantId` is
  the site hostname (`acme.atlassian.net`), which the OAuth path leaves empty
  because a 3LO token spans sites.
- `expiresAt` is set only from a `date` field (Jira) or from the vendor's own
  answer (GitHub's `github-authentication-token-expiration` response header on
  a token with an expiry — verify at build time; the research did not cover
  it).

### 3.4 What `verify()` does per provider, and what it reports

`verify()` is the validation step the person sees. It makes exactly the
identity call the OAuth `exchange` makes today and returns the same
`ConnectResult`, plus notes:

| Provider | Identity call | `label` | Preflight notes |
|---|---|---|---|
| Asana | `GET /users/me` | `<name> · <email>` | `ok` "Workspaces: Acme, Personal" (from `workspaces[]` — tenant discovery is free here) |
| Linear | `viewer { id name email }` | `<name> · <email>` | none the vendor lets us read — a key's Read/Write scope is not introspectable; a write-scoped need is discovered at the first write and refused by name (§5) |
| GitHub | `GET /user`, reading `X-OAuth-Scopes` | `<login>` | classic token: `ok`/`warning` per `repo`, `read:project`, `read:org`, `admin:repo_hook`; **fine-grained** (header absent): `warning` "Fine-grained token: repositories you granted; organisation projects only if you granted Projects; **your own projects never** (GitHub only lets a classic token read those)" |
| Jira Cloud | `GET <siteUrl>/rest/api/3/myself` | `<siteUrl host> · <email>` | `ok` "Signed in as <displayName>"; `warning` when `active` is false |
| Trello | `GET /1/members/me` | `<username>` | none |

The notes are adapter-authored strings with a stable `code` — the same shape
`TOOL_CATEGORIES` uses for `{ id, label, description }` — so a test can assert
on the code and the UI shows the sentence without a per-provider copy table.

### 3.5 Files

`packages/board-sources/src/adapter.ts` grows the types above and stays under
the cap by moving `CredentialForm`, `CredentialField`, `PreflightNote`,
`VerifiedCredential` and the auth-method types into a new
`packages/board-sources/src/auth.ts`, re-exported from `index.ts`.
`packages/board-source-jira/src/adapter.ts` (447 lines) splits its two
credential regimes into `packages/board-source-jira/src/auth.ts`
(`oauthMethod(config)`, `apiKeyMethod()`, `authHeaders(ctx)`, `apiBase(ctx,
container)`), leaving `adapter.ts` the container, page, webhook and write
code. The other three adapters gain an `auth.ts` the same way only if the
method objects push them over 500; Linear (378) and Trello (273, shrinking)
will not, GitHub (443) will.

## 4. Where the credential lives

### 4.1 `ScopedSetting` is the wrong shape, and why

The standard's cascade answers one question: *what is the value of key `K` for
person `P`, walking organisation → team → person, stopping at a lock*. A board
credential is not that question:

- A project uses **several** connections at once (a Jira key for one board, a
  Linear key for another), and each source names its connection explicitly —
  there is no "the Jira credential for this project" to resolve.
- The cascade has **no project scope** (T11) and the standard says settings
  walk past projects; the owner asked for project-level keys specifically.
- Nothing here is inherited or overridden. A project key does not *shadow* an
  organisation key; both are offered, and an administrator picks one.

The standard's own escape hatch — "a cascade with its own storage still states
the rule once", the cloud-browser credential rows governed by a lock-only
`ScopedSetting` — would apply only if there were a rule to state. The one
plausible rule ("the organisation says: only the organisation's Jira key may be
used") is speculative generality: nobody asked for it, and it is a lock row
plus one predicate whenever they do. Until then a connection has a scope and
routes gate by entitlement, which is Rule zero's second check, not a cascade.

The `Secret` vault table is also the wrong home: it stores references into an
Infisical project that a deployment may not have configured, its grants model
is for agents reading secrets in runs, and the board credential already has a
sealed row that every route and worker decrypts through one function
(`loadBoardSourceConnectionContext`). Moving it would add a dependency and
fork the decryption path.

### 4.2 The model

```prisma
enum BoardSourceConnectionScope { personal project organization }
enum BoardSourceAuthMethod { oauth api_key }
enum BoardSourceConnectionStatus { active needs_reauthorization expired revoked }   // + expired
enum BoardSourceHealth { active paused needs_reauthorization credential_expired owner_inactive misconfigured error }  // + credential_expired
enum BoardSourceProvider { jira linear trello github asana }                          // + asana

model BoardSourceConnection {
  id                String @id …
  organizationId    String
  scope             BoardSourceConnectionScope @default(personal)
  /// Set only at `personal` scope: the person whose authority this is.
  ownerUserId       String?
  /// Set only at `project` scope.
  projectId         String?
  /// Who pasted or authorised it. At `personal` this equals `ownerUserId`;
  /// at shared scopes it is the steward the row names beside the key.
  createdByUserId   String
  /// `user:<id>` | `project:<id>` | `org` — one string so the unique key
  /// holds across scopes without three nullable columns in it.
  scopeKey          String
  authMethod        BoardSourceAuthMethod @default(oauth)
  provider          BoardSourceProvider
  /// "acme.atlassian.net · jane@acme.com". Adapter-composed, never a secret.
  label             String
  externalAccountId String
  externalTenantId  String @default("")
  /// Non-secret values `verify()` returned — Jira's siteUrl. Validated by the
  /// adapter when stored and again by `hostPolicy` when dialled.
  credentialParams  Json @default("{}")
  status            BoardSourceConnectionStatus @default(active)
  grantedScopes     Json @default("[]")
  lastVerifiedAt    DateTime?
  createdAt / updatedAt

  owner     User?    @relation(…)              // optional now
  project   Project? @relation(…, onDelete: Cascade)
  createdBy User     @relation(…)

  @@unique([organizationId, scopeKey, provider, externalAccountId, externalTenantId])
  @@index([organizationId, scope])
  @@index([organizationId, projectId])
}
```

A `CHECK` ties the columns to the scope: `personal ⇔ owner_user_id IS NOT
NULL AND project_id IS NULL`, `project ⇔ project_id IS NOT NULL AND
owner_user_id IS NULL`, `organization ⇔ both NULL`. The migration backfills
every existing row with `scope = personal`, `createdByUserId = ownerUserId`,
`scopeKey = 'user:' || owner_user_id`, `authMethod = oauth` (Trello rows
become `api_key`), and `label` from `provider · externalAccountId`.

`BoardSource` gains `webhookSecretCiphertext String?` (§8) and nothing else;
`BoardSourceConnectionCredential` is unchanged.

### 4.3 Who may do what

| Action | `personal` | `project` | `organization` |
|---|---|---|---|
| Create (`POST …/connections/:provider/api-key`) | any active member, for themselves | `canAdministerProject` (`project-administration.ts` 20) on `projectId` | organisation owner |
| See it exists (list) | owner; organisation owners see whose (existing rule, `connections.ts` 280–292) | every administrator of that project; organisation owners | every active member — an organisation key is the organisation's, and a project administrator must be able to choose it |
| See its label, steward, status, expiry | same as above | same | same |
| List containers with it | owner | project administrators of that project | any project administrator in the organisation |
| Attach a source under it | owner, and only to projects they administer (existing) | administrators of that project, to that project only | any project administrator, to any project they administer |
| Rotate (`PUT …/:id/api-key`) | owner | project administrators | organisation owners |
| Delete | owner (`CONNECTION_IN_USE` refusal stays) | project administrators | organisation owners |
| Set a source to `read_write` | owner of the connection the source names (existing) | **refused**, `SOURCE_SHARED_KEY_READ_ONLY` | **refused** |

`createBoardSource`'s `CONNECTION_NOT_OWNED` check (`board-source-structure.ts`
176–177, repeated for re-pointing at 269) becomes a scope-aware `connectionUsableBy(actor, connection,
projectId)` predicate in `packages/team-admin/src/board-source-connection-access.ts`,
called by the attach route, the containers route and `PATCH …/sources/:id
{ connectionId }` — one predicate, three call sites, no route restating it.

Nothing here reads UOA. Project administration is Nessie-owned
(`ProjectMember.role`), organisation ownership is the existing `owner` role on
`OrganizationMember`, and the steward is a user id — a binding key, never a
profile copy.

### 4.4 Audit

Every credential-bearing mutation writes one hash-chained entry through
`writeAuditEntry` (`packages/db/src/audit-chain.ts` 176), which the existing
audit list at `api/src/services/audit.ts` already renders:

| `action` | `resourceType` / `resourceId` | `metadata` |
|---|---|---|
| `board_source_connection.created` | `board_source_connection` / connection id | `{ provider, scope, projectId?, authMethod, externalAccountId, externalTenantId, expiresAt? }` |
| `board_source_connection.rotated` | same | `{ previousExternalAccountId, externalAccountId, expiresAt? }` |
| `board_source_connection.deleted` | same | `{ provider, scope }` |
| `board_source_connection.expired` | same, actor `system` | `{ expiresAt }` |

Never the token, never the email. The entry's `actorId` is the steward for
create/rotate; the row's `createdByUserId` is updated on rotate so the
Connections row always names who last pasted a key. The OAuth path gains the
same `created` entry for symmetry, in the callback handler.

### 4.5 Rotation and revocation, and what happens to sources

- **Rotate** re-runs `verify()` on the new values, replaces the credential row,
  sets `status: active`, `lastVerifiedAt`, `externalAccountId` (may change at a
  shared scope; at `personal` a changed account is refused, `ACCOUNT_MISMATCH`,
  the same rule the OAuth re-authorization applies at `connections.ts` 150–160),
  and moves every source on the connection from `needs_reauthorization` or
  `credential_expired` to `active` with `nextRunAt = now()` — the same
  recovery the OAuth callback performs at 194–198. A rotation is a person's
  explicit act, so it may heal; a login never does.
- **Revoke** at the vendor shows up as a 401 → `SourceAuthError` →
  `needs_reauthorization` with reason `CREDENTIAL_REJECTED` (existing path,
  `board-source-sync.ts` 291–299). The remedy the surface shows depends on
  `authMethod`: *Reconnect* (OAuth popup) or *Replace key* (the rotate form).
- **Delete** is refused while sources name the connection (`CONNECTION_IN_USE`,
  existing) — the person re-points or removes those sources first. Deleting a
  project deletes its project-scoped connections (cascade); their sources are
  the project's and go with it.
- **Steward deactivated** (shared scope): nothing stops. The row shows *pasted
  by Jane (no longer a member)* in the warning tone, which is the cue to
  rotate. If the vendor also deprovisioned Jane, the next sync is the 401
  above. This is deliberate: the deactivation gate exists to end *delegated*
  authority, and a shared key's authority was delegated to the organisation
  or project by an administrator who is still there. `OWNER_INACTIVE` keeps
  its exact semantics for `personal` scope and is skipped for the others in
  `loadBoardSourceConnectionContext`.

## 5. Attribution: the options the owner asked for

A shared key authenticates as one person at every vendor here except Asana's
Enterprise Service Account (an organisation-level token Asana itself supports;
it fits the same one-field form and simply *is* the right thing to paste at
organisation scope). So the question is what a write made under a shared key
would look like at the vendor: Jira would show *Jane moved PROJ-12 to Done*
when Bob dragged it in Nessie.

**Option A — strictly "OAuth writes, keys read".** `read_write` requires
`authMethod: oauth`. Attribution is exact by construction. Cost: a deployment
with no registered OAuth app — the very deployment this design exists for —
has no write path at all, and a person who pasted their *own* Linear key with
Write scope is refused for no reason the vendor recognises.

**Option B — shared keys may write, with a banner.** `read_write` is allowed
at any scope; the source row and the drag-refusal copy say *writes appear as
Jane in Jira*; an owner acknowledges it once. Cost: the attribution problem is
back, now behind a checkbox; the vendor's audit trail lies about who acted,
and when Jane leaves, every write for months was "hers".

**Option C — recommended: attribution follows the scope, not the mechanism.**
`read_write` requires `scope: personal`. A personal connection is one
accountable person's whether it came from an OAuth redirect or a pasted key;
a shared connection is read-only. This is the owner's principle — *each user
has to authenticate themselves* for writes — applied to what actually makes a
write attributable. It keeps OAuth as a write path everywhere it exists, adds
personal keys as one where it does not, and needs no banner because a shared
key can never write.

The enforcement is one refusal in `updateBoardSource`
(`SOURCE_SHARED_KEY_READ_ONLY`, 409) and one line of copy on the drag refusal
already shipped as `SOURCE_READ_ONLY`: *"This board runs under the
organisation's Jira key, which is read-only. Connect your own Jira account
from Settings → Sources to move it from here."* The "Connect as me" remedy
(`PATCH …/sources/:id { connectionId }`) already exists for exactly that.

One honest limit under every option: Linear's key scopes are not readable, so
a personal key minted as Read cannot be told apart from Write until the first
`issueUpdate` is refused. The existing synchronous `SourceRejectedError` path
snaps the drag back with *"Your Linear key has no write scope — create one
with Write at linear.app/settings/account/security and replace it"*.

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

## 10. The connect flow, screen by screen

Owning surface: **Project → Settings → Sources**. `ConnectSourceDialog`
becomes three files under `admin/src/pages/project/settings/connect/`:
`ConnectSourceDialog.tsx` (the `Dialog` host and its step state),
`CredentialStep.tsx` (provider + method + scope + generic form + preflight),
`ContainerStep.tsx` (multi-select picker and import result). One `Dialog`, one
`TabBar` per choice, `FormField`/`FormError`/`EmptyState` from the shared kit,
no nested frames. Step state is transient (never a URL param).

### 10.1 Rule zero: home and doorways

| Capability | Owning surface | In-context doorways |
|---|---|---|
| Connect a provider by key, pick boards | `ConnectSourceDialog` from `/projects/:id/settings?section=sources` | board empty state **Connect a source**; header overflow **Connect a source…**; `/apps/:slug` **Use as a project board source** (all existing, unchanged) |
| Personal keys | `/settings/connections` → *Project tools* (`ProjectToolConnections`, existing) — rows gain method, expiry, **Replace key** | dialog step 1 "Just me"; bell alert deep link |
| Project keys | `SourcesSettingsSection` → a *Keys for this project* row list above the sources, same row component | dialog step 1 "This project"; a source row's *as Engineering Jira (project key)* text links to it |
| Organisation keys | `/settings/organization?tab=project-tools` — third tab beside Profile and Agents, `OrganizationAdministrationGate`, same row component with `scope="organization"` | dialog step 1 "Whole organisation" (owners); bell alert deep link; a source row's *as Acme Jira (organisation key)* text |
| Expiry warning | the connection's row (above) | bell (`board_source_credential_expiring`); `SourceStatusStrip` pill *key expires in 5 days* on the board |
| `credential_expired` | source row remedy **Replace key** | bell (`board_source_health`, existing); `SourceStatusStrip` |

### 10.2 Step 1 — where from, and how

The dialog opens with title **Connect a source** and the existing description.

**Accounts you can use** — a row list, one row per connection the caller may
attach (§4.3): `Jira · acme.atlassian.net · jane@acme.com` with a `Pill`
naming the scope (*Yours* / *This project* / *Organisation*), the status pill,
and for a key its expiry. Choosing a row jumps to step 2. Empty state, when
none: *You have not connected an account yet.* (existing copy) with the
provider list directly below, so the empty state is never a dead end.

**Or connect a new account** — five provider rows, glyph + name + the freshness
line from §8.2. Trello without a Power-Up is rendered, greyed, inert, with
*Needs a Trello Power-Up registered by an operator* — the scoped-settings
treatment of a control someone cannot use: visible and named, never hidden.
Choosing a provider expands the step in place:

1. **How** — a `TabBar` radiogroup only when `methods.length > 1`: **API key**
   (first, selected) · **Sign in with Linear**. Choosing sign-in triggers the
   existing popup flow and, on the callback's `postMessage`, selects the new
   connection and moves to step 2.
2. **Who can use it** — a `TabBar` radiogroup, shown for the API-key method:
   **Just me** · **This project** · **Whole organisation**; options the caller
   is not entitled to are greyed, inert and titled *Organisation owners can
   add an organisation key*. Help under it: *Shared keys are read-only. To
   move cards from Nessie into Jira, connect your own account.*
3. **The fields**, rendered from `form.fields` — `FormField` with the field's
   `label` and `help`; `secret` → password input; `url`/`email`/`date` → the
   matching input type; the whole form capped at `max-w-sm` per field, never
   the page. Above them, the `createLabel` as a link to `createUrl` (opens a
   new tab, `noopener`).

Per-provider copy, from the vendor facts:

| Provider | `createLabel` | fields and `help` |
|---|---|---|
| Asana | *Create a personal access token at app.asana.com → My apps* | **Personal access token** — *It sees exactly what you can see in Asana. An Enterprise service account token works here too and is the right choice for a shared key.* |
| Linear | *Create a personal API key at linear.app → Settings → Security* | **API key** — *Read access is enough for a shared key. Choose Write only if you are connecting as yourself and want to move issues from Nessie.* |
| GitHub | *Create a token at github.com → Settings → Developer settings* | **Personal access token** — *Which kind depends on what you will import: repositories work with either kind; organisation projects need a fine-grained token with Projects access or a classic token with `read:project`; your own projects need a classic token. We will tell you what this token can reach before you choose.* |
| Jira | *Create an API token at id.atlassian.com → API tokens* | **Site URL** (`https://your-team.atlassian.net`) — *The address you open Jira at.* · **Atlassian account email** — *The email you sign in to Atlassian with; Jira needs it beside the token.* · **API token** · **Expires on** — *Atlassian requires an expiry when you create the token. Enter the same date and we will remind you a week before it stops working.* |
| Trello | *Get a token from Trello* (the deployment-key authorize URL) | **Token** — *Trello shows the token after you approve; copy it here.* |

4. **Verify & connect** (primary; the only filled button in the dialog) posts
   `POST /api/board-sources/connections/:provider/api-key { scope,
   projectId?, values }`. The route calls `verify()`, and on success creates
   the connection and the sealed credential in one transaction, writes the
   audit entry, and returns `{ connection, preflight }`. The dialog then shows
   **Connected as Jane Doe · jane@acme.com** with each preflight note as a
   line (`ok` in the success tone, `warning` in warning) and moves to step 2.

Failure copy, by code:

| code | copy |
|---|---|
| `VALIDATION_ERROR` (site URL) | *Enter your Jira site as https://your-team.atlassian.net.* |
| `CREDENTIAL_REJECTED` (401/403 on the identity call) | *Jira did not accept that token. Check the email and token, or make a new one.* |
| `PROVIDER_UNREACHABLE` | *Jira could not be reached. Try again in a minute.* |
| `CONNECTION_DUPLICATE` | *That account is already connected as "acme.atlassian.net · jane@acme.com".* |
| `SCOPE_NOT_PERMITTED` | *Only organisation owners can add an organisation key.* |
| `PROVIDER_UNAVAILABLE` (Trello without Power-Up) | *Trello needs a Power-Up registered by an operator on this deployment.* |

The plaintext values travel once, in that request body, over the same
transport the Trello token travels today, and are never echoed. There is no
separate "test" route: verify-then-store in one call means one plaintext round
trip, not two.

### 10.3 Step 2 — what to bring in

Title line: **Bring in from Jira · acme.atlassian.net**, with *Change* linking
back. Below it a search input and a checkbox row list from
`GET /api/board-sources/connections/:id/containers` — `label` bold, `hint`
muted (*Acme · PROJ*), rows filter as the person types. A counter beside the
primary button: **Import 4 boards**. Twenty at most per import; the button
says so if exceeded.

Empty state: *This account cannot see any Jira projects. Check its
permissions at* `createUrl` *or connect a different account.* — with the
GitHub variant naming the preflight reason when there is one (*This
fine-grained token was not granted any repositories*).

Loading and errors use the existing query states; `CONNECTION_NEEDS_REAUTHORIZATION`
from the containers route becomes *Replace this key first* with the rotate
form one click away.

### 10.4 Import, and what the person sees after

**Import** posts `{ connectionId, containers: [{ container, name }] }`. The
route (`sources-import.ts`, split out of `sources.ts`):

1. Loads the connection through the scope predicate (§4.3); refuses the whole
   request for a connection the caller may not use.
2. Lists containers **once** and validates every requested one against that
   list (the existing re-list, no longer per container).
3. For each container, in order, in its own transaction: `describeContainer`,
   field reconciliation (below), `createBoardSource`, enqueue
   `board-source.sync.initial`. A throw or a `BoardSourceError` for one
   container records a `refused` entry `{ container, containerKey, error,
   message }` and continues.
4. Returns `200 { created: BoardSourceRecord[], refused: [...] }`.

Field reconciliation replaces `sources.ts` 164–181:

- same `name` and `type` → reuse; for `select`/`multi_select`, options missing
  by label are appended with fresh stable ids (a rename never rewrites a
  value; the parent design's option rule) — so the second board's "Priority"
  with an extra *Blocker* option grows the project's field rather than
  creating "Priority 2";
- same `name`, different `type` → create `"<name> (<container label>)"` and
  add a `note` to the created record: *"Priority" already exists as a select
  field; this board's text field was added as "Priority (Mobile)"*;
- `FIELD_NAME_TAKEN` on that fallback name → the field stays unmapped and the
  note says so. Nothing is dropped silently, which is what happens today (T6).

The dialog closes when everything was created, selecting the first new source
(`onCreated`). When something was refused, it stays open on a result view:
created rows with a success pill *Importing*, refused rows with the sentence
(*Jira answered 403 for PROJ — this account cannot browse it*), and a single
**Done**. Behind it, `SourcesSettingsSection` already lists the created
sources with *first sync running*.

### 10.5 The rotate form

The same `CredentialStep` form, opened as a `Dialog` titled **Replace the Jira
key** from any *Replace key* doorway, with `url`/`email`/`text` fields
prefilled from `credentialParams` and the label (the email is not stored in
plaintext, so it is *not* prefilled; the help says *the same address as
before, or a new one*), `secret` fields empty, `date` empty. Submit is
`PUT /api/board-sources/connections/:id/api-key { values }`.

## 11. Delivery

Every phase leaves the tree green, the existing four adapters working under
OAuth exactly as before, and nothing reachable that is not finished.

**Phase 1 — contract and registry.** `auth.ts` types; `adapter.ts` reshaped
(`auth`, `hostPolicy`, `delta`, `identityTenantKey`, required polling
interval); `sourceFetch` takes `hostPolicy` and `acceptStatuses`; the four
adapters move `oauth` under `auth` with declared capabilities; Trello loses
`oauth`, gains `apiKey` (token paste, deployment-key `createUrl`), and
`/trello/complete` plus the fragment code in `callback-page.ts` are deleted;
`registerBoardSourceAdaptersFromEnv` registers all providers and reports
unavailable ones; `GET /providers` returns the §3.2 shape; the two worker
tenant-key chains call `identityTenantKey`.
*Accept:* existing adapter, worker and route tests pass; a registry test
refuses an adapter with neither method; `GET /providers` on an env with
nothing set lists four providers with `api_key` and Trello as unavailable.

**Phase 2 — the credential model.** Migration: connection scope columns,
`scopeKey`, `authMethod`, `label`, `credentialParams`, `expired` status,
`credential_expired` health, `asana` provider, `webhookSecretCiphertext`,
`board_source_credential_expiring` alert kind and `boardSourceConnectionId`,
CHECKs, backfill. `board-source-connection-access.ts` predicate wired into
attach, containers and re-point. `loadBoardSourceConnectionContext` per §6.1.
`connections-api-key.ts` (create, rotate) and audit entries; `connections.ts`
lists by entitlement with `?projectId=`. `updateBoardSource` refuses
`read_write` off `personal`. `BoardSourceRecord` gains
`connectionAuthMethod`, `connectionScope`, `connectionLabel`.
*Accept:* route tests for every cell of the §4.3 table; a test that an expired
no-refresh credential yields `CREDENTIAL_EXPIRED` and never calls `refresh`;
a test that OAuth refresh behaviour is byte-for-byte unchanged; migration
round-trips existing rows.

**Phase 3 — API-key methods on the four.** Linear (bare header, per-team
webhook with per-source secret), GitHub (`X-OAuth-Scopes` preflight,
scope-gated repo hook with minted secret, Projects v2 poll-only), Jira Cloud
(`parseJiraSiteUrl`, Basic auth, `siteUrl`-based `apiBase`, poll-only,
`expiresAt` from the form), Trello (already done in phase 1). The worker's
`ensureWebhook` reads capabilities, stores the token hash before registering,
seals a returned secret; the webhook worker passes `signingSecret`.
*Accept:* per-adapter unit tests on header composition per method, on
`verify()` against recorded identity responses (including the GitHub
fine-grained header-absent case and the Jira `atlassian.net` boundary
cases), on `hostPolicy` refusals; a worker test that a `none`-capability
method never calls `ensureWebhook`.

**Phase 4 — Asana.** The package per §9, the intake route's handshake branch,
the 412 test.
*Accept:* normalisation, section→state, custom-field mapping, `addProject`
move, handshake round-trip against a stand-in, and the 412 test all green;
the sync engine's tests unchanged.

**Phase 5 — multi-import.** `CreateBoardSourceBodySchema` becomes plural;
`sources-import.ts`; field reconciliation with option union and the type-clash
fallback; `useCreateProjectSource` returns `{ created, refused }`.
*Accept:* a test attaching three containers where the second's `describe`
throws yields two created, one refused, two initial-sync jobs; a test that two
boards' "Priority" selects union options; a test that a select/text clash
creates the suffixed field and reports it.

**Phase 6 — the admin.** The three-file dialog; `ProjectToolConnections`
parameterised by scope and reused in `SourcesSettingsSection` (project keys)
and the new organisation tab; the source rows' remedies wired (T12) including
*Replace key*; `SourceStatusStrip` expiry pill; the alert row and deep link
for the new kind. Copy per §10.
*Accept:* `admin` tests for the generic form rendering each field kind, for
the entitlement-greyed scope options, for the result view with refusals; the
page-header test unchanged (the dialog has no header actions).

**Phase 7 — expiry sweep and docs.** `board-source.credentials.expiry` in
the worker; `docs/deployment/configuration.md` "Project board sources"
rewritten: OAuth env is optional and enables sign-in plus app-level webhooks,
Trello's env is required for Trello at all, `NESSIE_API_PUBLIC_URL` is still
what enables webhooks; `as-built.md` in the parent folder gains a pointer here
and this document gains its own as-built section when built.
*Accept:* a worker test that a connection expiring in six days writes exactly
one alert per steward and a second pass writes none; on the date, status
`expired`, every source `credential_expired`, one health alert per transition.

## 12. Not in v1

- **Jira Data Center / Server.** Bearer PAT against an arbitrary host, REST
  v2, `startAt` pagination — the research verified the auth shape only. It
  arrives as its own provider id sharing `board-source-jira`'s normaliser,
  behind an operator host allowlist, never as a `kind` flag on the Cloud
  adapter.
- **Jira Cloud custom domains.** Same allowlist; same reason (§7).
- **Asana OAuth.** No deployment asked for it; the PAT path covers personal and
  (via service accounts) organisation scope.
- **GitHub Projects v2 webhooks under a token.** Poll-only; org hooks need
  `admin:org_hook`, which nobody should grant a board.
- **Trello without a Power-Up.** Impossible by vendor design.
- **A lock: "only the organisation key may be used for Jira".** One
  lock-only `ScopedSetting` row and one predicate when someone asks (§4.1).
- **Sharing an OAuth connection at project or organisation scope.** Scope is
  offered on the API-key method only. An OAuth grant is a person's by
  construction; making it shared would be Option B by another door.
- **Linear team-restricted keys.** A key limited to some teams simply lists
  fewer teams; nothing to build, nothing to explain beyond the empty state.
- **Reading a Jira token's expiry from Atlassian.** No API; the person types it.
- **Comments, attachments, subtasks** from Asana — the parent design's §5.3
  reasons hold.
- **Per-key rate budgets.** One organisation key feeding ten boards shares one
  vendor budget (Linear 2 500/h per key; Asana 150/min free). The existing
  `rate_limited` backoff handles it; the remedy when it bites is a project key
  for the busy board, which the dialog already offers.

## 13. Risks and the default each proceeds on

- **Linear `webhookCreate` may not accept a `secret` input.** Default: store
  the secret the mutation returns; if it returns none either, Linear under a
  key is poll-only and declares `none`. Costs freshness, not correctness.
- **GitHub's token-expiration header.** Default: if absent at build time,
  GitHub has no stored expiry and behaves like Linear (§6.4).
- **Jira webhooks under Basic auth may actually work.** Default: `none`. If
  the console permits it on first live connect, the method's capability flips
  to `per_source` and the existing unsigned-token path applies; a declaration
  change, not a design change.
- **Asana's synchronous handshake and the intake route's body parsing.** The
  handshake POST has an empty body; the route must not require JSON. Default:
  the handshake branch runs before body handling.
- **A shared Jira key is one person's identity at Atlassian.** Reads under it
  appear as that person in Atlassian's own audit log, and the key dies with
  their Atlassian account. The organisation row names the steward for exactly
  this reason; the yearly rotation Atlassian now forces is operational load
  the owner should expect, and §6 is what keeps it from being a surprise.
