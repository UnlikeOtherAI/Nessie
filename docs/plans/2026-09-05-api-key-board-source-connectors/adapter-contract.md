# The auth abstraction

Part of [the API-key connector design](overview.md).

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

