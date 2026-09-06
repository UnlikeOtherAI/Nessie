# External systems as a board data source

Part of [the project boards design](overview.md).

## 5. External systems as a board data source (C)

### 5.1 Transport verdict — per provider

Every provider is a **native adapter** speaking the vendor's own API through
`@nessie/runtime` `safeFetch`, with the vendor's real webhooks and delta
mechanism. No vendor SDK (they call global `fetch`, which the root
`eslint.config.js` egress block bans), no MCP.

| Provider | Auth (deployment ↔ person) | Read API + delta | Webhooks | Write-back | State model → category default |
|---|---|---|---|---|---|
| **Jira Cloud** | OAuth 2.0 (3LO): app registered per deployment (`NESSIE_BOARD_JIRA_CLIENT_ID/SECRET`); scopes `read:jira-work write:jira-work read:jira-user offline_access`; rotating refresh tokens; `accessible-resources` → `cloudId` per site | `GET https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/search/jql?jql=…&nextPageToken=…&maxResults=100` (the pre-2025 `/search` is retired); delta = `updated >= <since>` ordered by updated with a 5-minute overlap; `GET /project/{key}/statuses`, `/field`, `/user/search` | `POST /rest/api/3/webhook` (`jira:issue_created/updated/deleted`, JQL-scoped); **expire after 30 days**, `PUT /webhook/refresh`; max 100 per app; **unsigned** → per-source URL token (§5.6) | Status only via `GET /issue/{key}/transitions` + `POST …/transitions {transition:{id}}` — a category change becomes "find a transition whose target is the bound/default state"; assignee `PUT /issue/{key}/assignee {accountId}`; fields `PUT /issue/{key}` | `statusCategory.key`: `new → todo`, `indeterminate → in_progress`, `done → done`; nothing maps to `review` until a person promotes a state |
| **Linear** | OAuth 2.0: per-deployment app (`NESSIE_BOARD_LINEAR_CLIENT_ID/SECRET`), `scope=read,write`, `actor=user`; tokens long-lived until revoked (refresh if the app is configured for expiring tokens) | GraphQL `https://api.linear.app/graphql`: `issues(filter:{team:{id:{eq}}, updatedAt:{gt}}, first:100, after, orderBy: updatedAt)` with `state{id,name,type}`, `assignee{id,name,email}`, `labels`, `priority`, `estimate`, `dueDate` | OAuth-app webhooks (configured once on the app, fire for every authorised workspace; `Linear-Signature` HMAC-SHA256 of the raw body, `webhookTimestamp` ≤ 60 s) — verify at build time (§11); adapter declares 5-minute polling as the fallback | `issueUpdate(id, {stateId, assigneeId, title, description, priority, dueDate, labelIds, estimate})` | `state.type`: `triage/backlog/unstarted → todo`, `started → in_progress`, `completed → done`, `canceled → archived`; a `started` state named for review is promoted by a person |
| **Trello** | Power-Up API key + secret per deployment (`NESSIE_BOARD_TRELLO_API_KEY/SECRET`); person authorises at `https://trello.com/1/authorize?scope=read,write&expiration=never&response_type=token…`; the token arrives in the URL fragment and is submitted **once** to `POST …/trello/complete` → encrypted | `GET /1/boards/{id}/lists`, `GET /1/boards/{id}/cards?customFieldItems=true&members=true`; no `since` on cards → poll re-reads open cards + `dateLastActivity` (fine at ≤1,000 cards); `GET /1/boards/{id}/actions?since=` for deletes | `POST /1/webhooks {callbackURL, idModel: boardId}`; Trello sends a **HEAD** first; `x-trello-webhook` = base64(HMAC-SHA1(body + callbackURL, secret)) | `PUT /1/cards/{id}?idList=`; `PUT …?idMembers=`; custom field items | Lists are states: first list → `todo`, last → `done`, others → `in_progress`; `closed` card → `archived` |
| **GitHub Issues** | **GitHub App** per deployment (`NESSIE_BOARD_GITHUB_APP_ID/PRIVATE_KEY/CLIENT_ID/CLIENT_SECRET/WEBHOOK_SECRET`); the person connects with user-to-server OAuth (8-hour tokens + refresh), which proves which installations they may attach; sync uses a 1-hour **installation token** minted from the app JWT | `GET /repos/{o}/{r}/issues?state=all&since=&sort=updated&direction=asc&per_page=100` (rows with `pull_request` dropped) | App webhook `issues` (+ `label`), `X-Hub-Signature-256`, `X-GitHub-Delivery` for idempotency | `PATCH /repos/{o}/{r}/issues/{n} {state, state_reason, title, body, labels, assignees}`; assignees must be collaborators | `open → todo`; `closed + completed → done`; `closed + not_planned → archived`; `in_progress`/`review` only via a bound label or a Projects v2 status |
| **GitHub Projects v2** | Same App; org permission **Projects: read & write**; same user-to-server link | GraphQL only: `node(id) { … on ProjectV2 { items(first:100, after) { nodes { id updatedAt content{…} fieldValues(first:20){…} } } } }`; delta by `updatedAt` per item | App webhook `projects_v2_item` (created/edited/reordered/converted/archived/deleted) | `updateProjectV2ItemFieldValue({projectId, itemId, fieldId, value:{singleSelectOptionId}})` — the `Status` field is the state; text/number/date/single-select fields map 1:1 to §4.2 | `Status` options: first → `todo`, last → `done`, others → `in_progress`; archived item → `archived` |

Rate limits (Jira dynamic 429 + `Retry-After`; Linear complexity budget;
GitHub 5,000/h per installation; Trello 300/10 s per key) are handled by one
`rate_limited` transient in the sync engine (§5.10), never by a provider branch
in the worker.

### 5.2 Why MCP is the wrong shape for sync — said plainly

The existing MCP connectors for Linear and Atlassian stay exactly as they are,
for what they are good at: an agent *talking to* Linear or Jira in a run —
searching, commenting, creating an issue conversationally. They are not a sync
transport, for four reasons that are facts rather than taste:

1. **The token cannot reach the vendor API.** T7: dynamic OAuth binds the
   token to `https://mcp.linear.app/mcp` (RFC 8707). Using it against
   `api.linear.app` fails. So "the user already signed in" buys nothing for a
   sync path.
2. **No cursors, no webhooks.** MCP tools are request/response. Keeping 2,000
   issues fresh means re-listing them, and there is no way to be told about a
   change.
3. **No stable schema.** Tool names and argument shapes are the vendor's to
   change without notice; a sync needs deterministic parsing and idempotent
   upserts keyed on stable ids.
4. **One connection per call** (`callInstanceTool` opens and closes). A
   first sync would open thousands.

A board source therefore never touches `McpServerInstance`. Where an App Store
row exists for the same vendor, the two are two install modes of one app (§6.6).

### 5.3 Sync model — mirror into `Task`

An external item becomes an ordinary `Task` row in the project, plus a
`TaskExternalLink` row carrying the external identity, the last-seen remote
state and the fingerprints echo suppression needs. Defended against the
alternatives on the axes asked for:

- **Board performance.** The board read is the existing task read with a join
  on a one-row link. No fan-out, no second store.
- **Degraded provider.** The board keeps rendering the mirror; the source's
  health state (§5.10) says how old it is. Live query-through would render an
  empty board.
- **Agents.** `Task.runId`, `assigneeAgentId`, `ApprovalRequest.taskId`,
  `UserAlert.taskId`, `WorkflowStepRun`, the PA's `ticket_*` tools — all keyed
  on `Task`. An agent can be assigned a Jira ticket exactly as a native task and
  the run lifecycle drives its status. A separate `ExternalItem` store would
  need every one of those re-implemented or bridged — the fork Rule zero names.
- **Search/filter.** `GET /api/tasks` filters, the board filter, and the
  attention summary all work unchanged.
- **Disclosure.** A mirrored task is project-scoped; the `ticket_*` reads
  already stamp `project:` for non-owners. The sync worker is not a run and
  reads nothing into a context. External **comments are not imported** in v1
  precisely because an upstream comment can have a narrower audience than the
  issue, and importing it would need its own basis.

### 5.4 Package layout — the `comms-connect` mould

```
packages/board-sources/            @nessie/board-sources   (core, no Prisma)
  src/adapter.ts                   BoardSourceAdapter contract (below)
  src/registry.ts                  registerBoardSourceAdapter / resolveBoardSourceAdapter
  src/items.ts                     NormalisedItem, OutboundChange, itemFingerprint()
  src/oauth-state.ts               state payload shape (mirrors comms)
  src/errors.ts                    SourceRejectedError { code, detail }, SourceAuthError, SourceRateLimitedError
  src/webhook.ts                   WebhookRequest, verification helpers (HMAC-SHA256/SHA1, timing-safe)
packages/board-source-jira/        @nessie/board-source-jira
packages/board-source-linear/      @nessie/board-source-linear
packages/board-source-trello/      @nessie/board-source-trello
packages/board-source-github/      @nessie/board-source-github  (issues + projects v2 containers)
packages/board-source-providers/   @nessie/board-source-providers — registerBoardSourceAdaptersFromEnv()
```

One package per provider, as comms does, so vendor-specific parsing stays under
the 500-line cap per file and an unconfigured provider is simply not
registered — the picker never offers it and its jobs park on
`AdapterNotRegisteredError`. Registration happens at API and worker startup
from `NESSIE_BOARD_*` env, beside `registerCommsConnectorsFromEnv`.

```ts
// packages/board-sources/src/adapter.ts
export interface BoardSourceAdapter {
  readonly provider: BoardSourceProvider
  readonly incrementalPollingIntervalMs?: number       // declared fallback when webhooks are absent
  oauth: {
    buildAuthorizeUrl(input: { state: string; redirectUri: string; codeChallenge?: string }): string
    exchange(input: OAuthExchangeInput): Promise<ConnectResult>      // { externalAccountId, externalTenantId, credential, grantedScopes }
    refresh(credential: CredentialBundle): Promise<CredentialBundle>
  }
  listContainers(ctx: ConnectionContext): Promise<ContainerDescriptor[]>          // Jira projects, Linear teams, Trello boards, GitHub repos + projects
  describeContainer(ctx, container): Promise<ContainerDescription>             // { states, fields, members }
  fetchPage(ctx, container, checkpoint: SyncCheckpoint): Promise<SyncPage>       // initial and incremental, by checkpoint
  fetchItems(ctx, container, externalIds: string[]): Promise<NormalisedItem[]>  // after a webhook that carries ids only
  searchItems(ctx, container, query: RemoteItemQuery): Promise<NormalisedItem[]>  // live read for items the mirror does not hold; §5.13
  ensureWebhook(ctx, container, callback: { url: string; token: string }): Promise<WebhookRegistration | null>
  verifyWebhook(request: WebhookRequest, secrets: WebhookSecrets): boolean
  parseWebhook(request: WebhookRequest): WebhookDelivery                        // { deliveryId, containerKey, items | externalIds }
  applyChange(ctx, container, item: NormalisedItem, change: OutboundChange): Promise<NormalisedItem>  // returns the vendor's echo
}

export type NormalisedItem = {
  externalId: string; externalKey: string; url: string
  title: string; description: string | null
  stateId: string; stateName: string
  assignee: { externalUserId: string; displayName: string; email?: string } | null
  priority: string | null                    // provider raw, mapped by the source
  dueDate: string | null                     // YYYY-MM-DD
  labels: { id: string; label: string }[]
  fields: Record<string, unknown>            // by external field key
  createdAt: string; updatedAt: string
  archived: boolean                          // deleted, trashed, cancelled upstream
}
```

`itemFingerprint(item, mapping)` hashes only the **mapped** fields, in mapping
order — it is what echo suppression compares (§5.7).

### 5.5 Model

```prisma
enum BoardSourceProvider { jira linear trello github }
enum BoardSourceConnectionStatus { active needs_reauthorization revoked }
enum BoardSourceWriteMode { read_only read_write }
enum BoardSourceHealth { active paused needs_reauthorization owner_inactive misconfigured error }

/// One person's delegated authority at one provider, reusable across projects.
model BoardSourceConnection {
  id                String                      @id @default(uuid()) @db.Uuid
  organizationId    String                      @map("organization_id") @db.Uuid
  ownerUserId       String                      @map("owner_user_id") @db.Uuid
  provider          BoardSourceProvider
  /// The provider's stable account id: Atlassian accountId, Linear user id,
  /// Trello member id, GitHub user id. Never a display name, never an email.
  externalAccountId String                      @map("external_account_id")
  /// Linear organisation id, GitHub installation id; empty for Jira (a 3LO
  /// token spans sites — the container carries the cloudId) and Trello.
  externalTenantId  String                      @default("") @map("external_tenant_id")
  status            BoardSourceConnectionStatus @default(active)
  grantedScopes     Json                        @default("[]") @map("granted_scopes")
  lastVerifiedAt    DateTime?                   @map("last_verified_at")
  createdAt         DateTime                    @default(now()) @map("created_at")
  updatedAt         DateTime                    @updatedAt @map("updated_at")

  organization Organization                     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  owner        User                             @relation("BoardSourceConnectionOwner", fields: [ownerUserId], references: [id], onDelete: Cascade)
  credential   BoardSourceConnectionCredential?
  sources      BoardSource[]

  @@unique([organizationId, ownerUserId, provider, externalAccountId, externalTenantId])
  @@index([organizationId, ownerUserId])
  @@map("board_source_connections")
}

/// Encrypted with the same `credential-crypto` seam comms uses. Never read by
/// any route; decrypted only in `loadBoardSourceCredential` (@nessie/team-admin).
model BoardSourceConnectionCredential {
  id                     String    @id @default(uuid()) @db.Uuid
  connectionId           String    @unique @map("connection_id") @db.Uuid
  accessTokenCiphertext  String    @map("access_token_ciphertext")
  refreshTokenCiphertext String?   @map("refresh_token_ciphertext")
  expiresAt              DateTime? @map("expires_at")
  keyVersion             Int       @default(1) @map("key_version")
  createdAt              DateTime  @default(now()) @map("created_at")
  updatedAt              DateTime  @updatedAt @map("updated_at")
  connection BoardSourceConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  @@map("board_source_connection_credentials")
}

/// Single-use OAuth state bound to (user, provider, organization); mirrors
/// `CommsOAuthState`. Carries PKCE, `targetConnectionId` on re-authorization,
/// and `expectedAccountId` so a re-auth cannot re-point to another account.
model BoardSourceOAuthState {
  token          String              @id
  organizationId String              @map("organization_id") @db.Uuid
  userId         String              @map("user_id") @db.Uuid
  provider       BoardSourceProvider
  payload        Json
  expiresAt      DateTime            @map("expires_at")
  createdAt      DateTime            @default(now()) @map("created_at")
  @@map("board_source_oauth_states")
}

/// One external container (Jira project, Linear team, Trello board, GitHub
/// repo or Projects v2 board) feeding one Nessie project.
model BoardSource {
  id               String               @id @default(uuid()) @db.Uuid
  projectId        String               @map("project_id") @db.Uuid
  organizationId   String               @map("organization_id") @db.Uuid
  connectionId     String               @map("connection_id") @db.Uuid
  provider         BoardSourceProvider
  name             String                                       // "Jira · PROJ", editable
  /// Provider-specific, validated by the adapter's ContainerSchema:
  /// jira { cloudId, projectKey, jql? } · linear { teamId } · trello { boardId }
  /// · github { kind: 'repository', owner, repo } | { kind: 'project', ownerLogin, projectNumber, nodeId }
  container        Json
  /// Adapter-computed canonical string of `container`, for the unique key.
  containerKey     String               @map("container_key")
  writeMode        BoardSourceWriteMode @default(read_only) @map("write_mode")
  /// [{ externalStateId, externalStateName, category: ColumnCategory | 'archived' | null, isDefaultForCategory }]
  stateMapping     Json                 @default("[]") @map("state_mapping")
  /// [{ externalKey, externalLabel, externalType, target: 'native:priority' | … | 'field:<id>', valueMap?: Record<string,string> }]
  fieldMappings    Json                 @default("[]") @map("field_mappings")
  /// Done/archived items older than this are not imported on the first sync.
  syncWindowDays   Int                  @default(30) @map("sync_window_days")

  healthState         BoardSourceHealth @default(active) @map("health_state")
  /// Stable code, never an upstream message; the surface explains from it.
  healthReason        String?           @map("health_reason")
  healthDetail        String?           @map("health_detail")
  healthRevision      Int               @default(0) @map("health_revision")
  lastSyncStartedAt   DateTime?         @map("last_sync_started_at")
  lastSyncCompletedAt DateTime?         @map("last_sync_completed_at")
  lastErrorCode       String?           @map("last_error_code")
  consecutiveFailures Int               @default(0) @map("consecutive_failures")
  nextRunAt           DateTime?         @map("next_run_at")
  claimedAt           DateTime?         @map("claimed_at")
  /// SyncCheckpoint — { cursor?, since?, phase: 'initial' | 'incremental' }
  checkpoint          Json              @default("{}")

  webhookExternalId String?   @map("webhook_external_id")
  webhookExpiresAt  DateTime? @map("webhook_expires_at")
  /// SHA-256 of the per-source URL token, for providers that do not sign (Jira).
  webhookTokenHash  String?   @map("webhook_token_hash")

  createdByUserId String   @map("created_by_user_id") @db.Uuid
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  project      Project               @relation(fields: [projectId], references: [id], onDelete: Cascade)
  organization Organization          @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  connection   BoardSourceConnection @relation(fields: [connectionId], references: [id], onDelete: Restrict)
  links        TaskExternalLink[]
  healthAlerts UserAlert[]           @relation("BoardSourceHealthAlert")

  @@unique([projectId, provider, containerKey])
  @@index([nextRunAt, claimedAt])
  @@index([organizationId, healthState])
  @@map("board_sources")
}

model TaskExternalLink {
  id                       String    @id @default(uuid()) @db.Uuid
  organizationId           String    @map("organization_id") @db.Uuid
  taskId                   String    @unique @map("task_id") @db.Uuid
  sourceId                 String    @map("source_id") @db.Uuid
  externalId               String    @map("external_id")
  externalKey              String    @map("external_key")        // "PROJ-123", "ENG-42", "#17"
  externalUrl              String    @map("external_url")
  remoteStateId            String?   @map("remote_state_id")
  remoteStateName          String?   @map("remote_state_name")
  /// Provider display data for an assignee no identity link resolves. Not a
  /// person record: it is what the card shows as "J. Doe (Jira)".
  remoteAssigneeExternalId String?   @map("remote_assignee_external_id")
  remoteAssigneeDisplay    String?   @map("remote_assignee_display")
  externalUpdatedAt        DateTime? @map("external_updated_at")
  remoteDeletedAt          DateTime? @map("remote_deleted_at")
  inboundFingerprint       String?   @map("inbound_fingerprint")
  outboundFingerprint      String?   @map("outbound_fingerprint")
  lastInboundAt            DateTime? @map("last_inbound_at")
  lastOutboundAt           DateTime? @map("last_outbound_at")
  createdAt                DateTime  @default(now()) @map("created_at")
  updatedAt                DateTime  @updatedAt @map("updated_at")

  task   Task        @relation(fields: [taskId], references: [id], onDelete: Cascade)
  source BoardSource @relation(fields: [sourceId], references: [id], onDelete: Cascade)

  @@unique([sourceId, externalId])
  @@map("task_external_links")
}

/// The only place a provider identity meets a Nessie identity. Scoped to the
/// provider tenant, not the source, so one mapping serves every project.
model BoardSourceIdentityLink {
  id                  String              @id @default(uuid()) @db.Uuid
  organizationId      String              @map("organization_id") @db.Uuid
  provider            BoardSourceProvider
  /// Jira cloudId, Linear organisation id, 'trello', 'github'.
  externalTenantKey   String              @map("external_tenant_key")
  externalUserId      String              @map("external_user_id")
  externalDisplayName String?             @map("external_display_name")
  userId              String?             @map("user_id") @db.Uuid
  agentId             String?             @map("agent_id") @db.Uuid
  matchedBy           String              @map("matched_by")            // 'email' | 'manual'
  createdByUserId     String?             @map("created_by_user_id") @db.Uuid
  createdAt           DateTime            @default(now()) @map("created_at")
  updatedAt           DateTime            @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user         User?        @relation(fields: [userId], references: [id], onDelete: Cascade)
  agent        Agent?       @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@unique([organizationId, provider, externalTenantKey, externalUserId])
  @@map("board_source_identity_links")
}
```

`Task` gains `externalLink TaskExternalLink?`. `UserAlertKind` gains
`board_source_health`; `UserAlert` gains `boardSourceId` with the
`BoardSourceHealthAlert` relation. Migration
`20260906120000_board_sources/`. A `CHECK` on `board_source_identity_links`
requires exactly one of `user_id` / `agent_id`, or neither (an unmatched
provider identity a person has seen and left unmapped).

Under the UOA rule: no row here holds a person's email, name or avatar as
Nessie identity. `externalDisplayName` and `remoteAssigneeDisplay` are the
provider's own data about the provider's own user, kept so the mapping table
and the card can name who is unmapped; `userId` is a binding key of the same
kind as `User.uoaSub`. Nothing here is ever promoted to a `User`.

### 5.6 Inbound sync

Topics in `packages/schemas/src/board-sources.ts`, handlers in
`worker/src/control/board-source-sync.ts` and `board-source-webhook.ts`:

| topic | payload | what it does |
|---|---|---|
| `board-source.sync.initial` | `{ sourceId }` | `describeContainer` → seed default mappings if empty → page through `fetchPage` from an empty checkpoint, ≤100 pages per job, persisting the checkpoint after every page (resumable) → `ensureWebhook` → `healthState: active`, `nextRunAt` |
| `board-source.sync.incremental` | `{ sourceId }` | `fetchPage` from the stored checkpoint; on `SourceCursorExpiredError` reset to a bounded re-sync (the comms `resetJobForBoundedResync` shape) |
| `board-source.sync.sweep` | `{ bucket }` | periodic: claim sources with `nextRunAt <= now() AND claimed_at IS NULL` by a single conditional UPDATE, enqueue incremental — the trigger poller's claim shape, no second scheduler |
| `board-source.webhook.process` | `{ provider, deliveryId, sourceId?, headers, body }` | `verifyWebhook` → `parseWebhook` → `fetchItems` when the payload carries ids only → apply; idempotent on `deliveryId` |
| `board-source.webhooks.renew` | `{ withinMs }` | re-registers webhooks expiring inside the window (Jira's 30 days); mirrors `comms.subscriptions.renew` |

Intake route: `POST /api/board-sources/webhooks/:provider/:token?` (public,
`HEAD` answered 200 for Trello), which does nothing but enqueue — verification
happens in the worker with the deployment secret and, for Jira, the source's
`webhookTokenHash`. Same split comms uses.

**Applying an item** — `applyInboundItem(prisma, source, item)` in
`packages/team-admin/src/board-source-apply.ts` (Prisma-aware and shared,
because the API applies the vendor's echo on a write-back, §5.7):

1. `fingerprint = itemFingerprint(item, source)`. If it equals
   `link.outboundFingerprint` → this is our own write coming back: advance
   `externalUpdatedAt`/`lastInboundAt`, write no `TaskEvent`, publish nothing.
   If it equals `link.inboundFingerprint` → nothing changed on a mapped field;
   same treatment.
2. Otherwise upsert the task: `title`, `detail` (description), `priority`
   through the mapping's `valueMap`, `dueDate`, `assigneeUserId`/
   `assigneeAgentId` through the identity link (or `null` + the link's
   `remoteAssignee*`), `fieldValues` for every mapped field (unmapped Nessie
   fields untouched), `status` from the state mapping.
3. **Status bypasses `VALID_TRANSITIONS`** — the vendor is the authority for
   its own item — and writes a `status_changed` `TaskEvent` with
   `{ bySourceId, from, to, remoteStateId }`. `todo` becomes `assigned` when an
   assignee resolved, else `inbox`; `archived` becomes `cancelled` +
   `archivedAt`. A state with no mapping leaves `status` untouched and moves
   the source to `misconfigured` with `healthReason: 'UNMAPPED_STATE'`,
   `healthDetail: <state name>` (a person maps it; §5.10).
4. Publish `board.updated { projectId }` (§7.4) once per job, not per item.

Initial import bounds: every non-done item in the container plus
done/archived items updated within `syncWindowDays`. A Jira project with
40,000 resolved issues is why the default is 30 days.

### 5.7 Write-back

`writeMode` is per source and defaults to `read_only`. Authority per field is
then a consequence, not a matrix:

- **Source-owned fields** are the mapped ones: state, title, detail, assignee,
  priority, due date, and every mapped custom field. In `read_only` a person
  may pin and reorder a mirrored card within its category, and edit every
  Nessie-only field (unmapped custom fields, story points unless mapped,
  iteration, owner), but a category-changing move, a title edit, or an
  assignment is refused with `409 SOURCE_READ_ONLY` and copy that names the
  remedy: *"Jira owns this ticket's status. Switch the source to read & write
  in Settings → Sources to move it from here."*
- **In `read_write`** the same actions call the adapter **before** the local
  transaction. `moveProjectTaskToColumn`, `updateProjectTask` and
  `assignProjectTask` take an injected `writeBack: BoardSourceWriteBack` —
  `{ apply(link, change): Promise<NormalisedItem> }` built by the API from the
  registry and by the worker identically — and on success apply the vendor's
  echo through `applyInboundItem` in the same transaction as the placement,
  stamping `outboundFingerprint = itemFingerprint(echo)`. The mirror is
  written from the echo, never from the request (the UOA rename rule).
- **Refusal is synchronous.** `SourceRejectedError { code, detail }` becomes
  `409 SOURCE_REJECTED` and the drag snaps back with the reason
  (`JIRA_NO_TRANSITION` "PROJ-123 has no transition to *Done* from *In Review*";
  `ASSIGNEE_NOT_LINKED` "Alice isn't linked to a Jira account — link her in
  Settings → Sources → Jira → People"). No async revert, no toast a minute
  later. Provider calls run under the dashboard fetch envelope: 10 s, `safeFetch`,
  `maxRedirects: 0`.
- **Which external state a move writes:** the destination column's
  `stateBindings` entry for this source if it has one, else the source
  mapping's `isDefaultForCategory` state. Jira additionally resolves a
  transition whose target is that state; none → `JIRA_NO_TRANSITION`.
- **Conflicts.** Inbound applies only when the item's fingerprint differs from
  both stored fingerprints (§5.6); outbound is synchronous and re-reads the
  echo. Because a local edit to a mapped field is only possible through a
  successful write-back, local and remote cannot diverge on a mapped field by
  construction; there is no merge to do.
- **Agents.** The PA's `ticket_move` / `ticket_update` / `ticket_assign` call
  the same functions with the same collaborator and get the same refusals in
  words, acting as the person — the button has no approval gate, so the tool
  mirrors it (personal-assistant-tools.md). Unattended runs have no acting
  member and already refuse. The run lifecycle (`updateTaskStatus`) does
  **not** write back in v1; §10 records the hook.

### 5.8 Mapping

Configured on the source's page in Project → Settings → Sources, by a project
administrator; seeded on attach from the adapter's `describeContainer` so the
first sync is right without configuration.

- **State → category** (`stateMapping`): a table of the container's states,
  each with a category picker (`To do / In progress / Review / Done /
  Archived / Not mapped`) and a "default for this category" radio. Defaults
  come from the provider's own type where it has one (Jira `statusCategory`,
  Linear `state.type`, GitHub `state` + `state_reason`) and from list order
  where it does not (Trello, Projects v2 `Status`). `review` starts empty
  everywhere — nothing guesses a state's meaning from its name; a person
  promotes it.
- **Column state bindings** (`BoardColumn.stateBindings`): in the Boards
  section, a column's row offers "Shows external states…" listing the states
  of every source in the project whose mapped category equals the column's.
  A bound column places items in those states (§3.3) and writes back to the
  first bound state (§5.7). Unbound columns keep category behaviour.
- **Assignee → person or agent** (`BoardSourceIdentityLink`): a People table
  of the container's members with the resolved Nessie identity. Auto-match on
  **exact email equality** against `User.email` of an active member, where the
  provider exposes email (Jira with `read:jira-user`, subject to the account's
  privacy setting; Linear; GitHub only when public; Trello never) — a read of
  UOA-mirrored data, not a store of provider data; the mapping row records
  `matchedBy: 'email'`. Everything else is manual through the same
  `AssigneePicker`, which also lets a provider bot user map to a Nessie
  **agent** so an agent assignee writes back as that bot.
- **Priority → `Task.priority`**: a fixed per-provider `valueMap` in the
  adapter (Jira Highest/High → `urgent`/`high`, Medium → `medium`, Low/Lowest
  → `low`; Linear 1→`urgent`, 2→`high`, 3→`medium`, 4→`low`, 0→`medium`),
  editable on the Fields table.
- **Labels, types, estimates, dates → custom fields** (`fieldMappings`): the
  Fields table lists external fields with a target picker — a native field, an
  existing definition of a compatible type, or *Create field*. Defaults per
  §4.6.

### 5.9 Identity and tenancy

- A **connection** is one person's delegated authority at one provider, tenanted
  to the organisation. Anyone may create one for themselves. It appears on
  their **Connections** page (`/settings/connections`, the existing per-user
  connections surface) under a *Project tools* group, with Reconnect and
  Remove.
- A **source** is per project, created by a project administrator **who owns
  the connection it names**. An org owner may not attach somebody else's
  connection: that would run a sync under a credential its owner never pointed
  at that project. `PATCH …/sources/:id { connectionId }` is restricted the
  same way and is the "Connect as me" remedy.
- Sync runs under the connection owner's credential. When that person is
  deactivated, the sweep skips the source (the comms `isConnectionOwnerActive`
  gate) **and** transitions it to `owner_inactive` — the comms precedent skips
  silently, which is the defect the health standard was written after. Remedy:
  another administrator connects and takes it over.
- Removing a connection that sources still name is refused
  (`CONNECTION_IN_USE`, naming the projects); the person pauses or re-points
  those sources first.

### 5.10 Health — every state names its remedy

| `healthState` | Meaning | Remedy the surface shows | Alert |
|---|---|---|---|
| `active` | syncing; `lastSyncCompletedAt` is the freshness | — | — |
| `paused` | a person paused it | **Resume** | — |
| `needs_reauthorization` | the provider rejected the credential (401/403 not caused by a permission) | **Reconnect** (starts OAuth bound to the connection) | once |
| `owner_inactive` | the connection owner is no longer an active member | **Connect as me** | once |
| `misconfigured` | `UNMAPPED_STATE`, `CONTAINER_GONE`, `FIELD_GONE`, `WEBHOOK_REGISTRATION_FAILED` | **Edit mapping** → the offending row highlighted | once |
| `error` | anything else, with `lastErrorCode` (`SOURCE_TIMEOUT`, `SOURCE_HTTP_ERROR`, …) after backoff exhausted (six hours) | **Retry now** | once |

Transient `429`/`5xx` set `consecutiveFailures` and `nextRunAt` by the capped
exponential backoff `dashboard-refresh.ts` uses and change no health state; the
board's freshness pill simply ages. The transition is claimed by the single
conditional UPDATE that bumps `healthRevision`; the same statement's success is
what enqueues `board-source.health-alert`, which writes one `UserAlert
(kind: board_source_health, eventKey: 'board-source-health:<sourceId>:<revision>')`
per recipient — the project's owners/admins, the organisation's owners and the
connection owner — under the existing `(user_id, event_key)` uniqueness, and
pushes under a new `pushBoardSourceHealth` preference with a generic body. The
alert is revalidated on read (`visibleUserAlertWhere`) so it disappears when the
source is healthy again. Recovery is explicit — the buttons above — and never
happens at login.

### 5.11 Egress and disclosure

Every provider call goes through `safeFetch` with a per-adapter origin
allowlist (`api.atlassian.com`, `auth.atlassian.com`, `api.linear.app`,
`api.trello.com`, `api.github.com`, `github.com`), `maxRedirects: 0` whenever a
credential is attached, a 1 MiB response cap and `Accept-Encoding: identity`
— the `fetchDashboardSource` envelope, relocated into
`packages/board-sources/src/http.ts` as `sourceFetch` so both engines call one
function. Vendor SDKs are not used (they bypass the lint's ratchet). OAuth
exchanges follow `mcp-oauth-completion.ts`: PKCE where the provider supports
it, state single-use and TTL-bound, `expectedAccountId` on re-authorisation.

Disclosure: a mirrored task carries no basis of its own; the reads that put it
into a run's context are the existing `ticket_*` tools, which stamp `project:`
for non-owners already. The one new read, `ticket_fields_read`, stamps the
same scope. Comments stay out (§5.3).

### 5.12 What this takes from Dashboards, and what it does not

Taken verbatim, because they are security decisions rather than features:
plaintext credentials submitted once and minted to a server-side ref (here the
encrypted credential row; the only plaintext path is Trello's one-shot token
POST); a visible source authority (`connection.ownerUserId`) whose access every
viewer of the project sees through; the `nextRunAt/claimedAt` claim, capped
backoff, `consecutiveFailures` and stable `lastErrorCode`; one network
chokepoint; loopback denial. Not taken: `DashboardDataSource`, datasets,
JMESPath, output columns. A dashboard source produces an immutable read-only
table with no row identity and no write path; a board source produces mutable,
identity-preserving, bi-directional mirrors. Extending the dashboard tables
would have meant three forks — a write path, row identity and webhooks — inside
a model built to have none.

### 5.13 Searching the provider directly

`searchItems` is the one read that does **not** go through the mirror, and it
is not the live query-through §2 rejected: nothing it returns is written to a
`Task`, and no board renders it. It answers the question the mirror
structurally cannot — an item outside the sync window, in a state the mapping
drops, or newer than the last sweep is simply not here, and "I cannot see it"
was the only honest answer an assistant could give.

- **Bounded to the container.** Every query carries the source's own container,
  because a source is one person's delegated authority pointed at one Jira
  project, Linear team, Trello board or GitHub repository. Trello's `idBoards`
  and GitHub's `repo:` qualifier are what enforce that at the vendor; without
  them the provider's own search ranges over everything the credential can
  reach, which is the whole account.
- **The text is data.** Jira's JQL and GitHub's qualifier grammar are query
  languages, so the escaping for each lives in one named function
  (`jiraSearchJql`, `gitHubSearchQuery`) with tests that assert a quote in a
  person's words stays inside the string literal rather than becoming a clause
  or a second `repo:`. Linear and Trello take the text as a variable and a
  query parameter, so neither has a grammar to escape into.
- **A partial answer says so.** Sources are asked concurrently; one that
  refuses, times out, or belongs to a deactivated owner is named in
  `unavailable` with its reason rather than dropped, because an answer missing
  a whole provider must not read as an empty result.
- **Paused stays paused.** A source a person stopped is not asked.
- **Results say what is mirrored.** Each match carries the local `taskId` when
  one exists. An item without one cannot be moved, assigned or transitioned
  until it syncs, and a search that did not distinguish them would invite
  exactly that.

The assistant reaches this as `ticket_search_remote` (§7), after
`ticket_search`, which covers everything already mirrored and is the set it can
act on.
