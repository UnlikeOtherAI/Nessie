# API-key connectors for project board sources

**Date:** 2026-09-05 · **Status:** design, not yet built
**Owning surfaces:** Project → **Settings → Sources**
(`/projects/:projectId/settings?section=sources`) for the connect flow and for
project-scoped keys; the per-user **Connected accounts** page
(`/settings/connections` → *Project tools*) for personal keys; Organisation →
**Settings → Project tools** (`/settings/organization?tab=project-tools`, new
tab) for organisation-scoped keys.
**Extends:** [2026-09-05-project-boards-external-sources-and-custom-fields](../2026-09-05-project-boards-external-sources-and-custom-fields/overview.md)
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


## Table of Contents

The design is one argument in five parts; each chapter is authoritative for its
own area, and this page is the map. Section numbers are stable — a reference to
"§4.2" means section 4.2, wherever it now lives.

- **[The auth abstraction](adapter-contract.md)** — §3. How one adapter offers
  both an OAuth grant and a pasted credential, how a provider declares the
  credential form the admin renders, what `verify()` reports back per provider,
  and what the env gate becomes.
- **[Where the credential lives](credential-scope.md)** — §4–§5. Personal,
  project and organisation scope; why `ScopedSetting` is the wrong shape; who
  may create, see and rotate a shared key; the audit story; rotation and
  revocation; and the three attribution options the owner asked for.
- **[Expiry, egress, capabilities and Asana](provider-constraints.md)** — §6–§9.
  Jira's mandatory token expiry and the state that names it; the SSRF surface of
  a typed site URL; how a provider declares its webhook and delta capabilities
  so no surface guesses; and Asana as the fifth adapter.
- **[Surfaces](surfaces.md)** — §10. The owning surface and its doorways, the
  connect flow field by field, the multi-select picker, what import looks like
  afterwards, and the rotate form.
- **[Delivery](delivery.md)** — §11–§13. The seven phases with their acceptance
  checks, what is deliberately not in v1, and the risks with the default each
  proceeds on — including the four vendor facts that cannot be settled without a
  live account.
