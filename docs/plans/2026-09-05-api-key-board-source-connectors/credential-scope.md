# Where the credential lives, and who may write with it

Part of [the API-key connector design](overview.md).

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

