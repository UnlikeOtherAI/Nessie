# Import from board sources

Part of [ticket comments, attachments and labels](overview.md).

## 4. Import

The mirror-into-`Task` model is unchanged: an external issue is a `Task` with a
`TaskExternalLink`. This chapter adds three more things the sync carries —
labels with their colour, comments, and files (including the images inside
descriptions and comments) — keeps the adapter "strictly the connector
layer", and puts every mapping and identity decision in
`@nessie/team-admin`.

### 4.1 Contract extension — `packages/board-sources`

`src/items.ts`:

```ts
export type NormalisedItemLabel = { id: string; label: string; color?: string }   // '#rrggbb'

export type NormalisedComment = {
  externalId: string
  issueExternalId: string
  body: string                                   // Markdown
  author: NormalisedItemAssignee | null          // { externalUserId, displayName, email? }; null = a bot or unknown
  authorDisplay?: string | null                  // when `author` is null (a bot actor)
  createdAt: string
  updatedAt: string
  editedAt?: string | null
  url?: string | null
  parentExternalId?: string | null
  /** Narrower audience than the issue (Jira `visibility`). Never imported. */
  restricted?: boolean
}

export type NormalisedAttachment = {
  externalId?: string                            // the provider's id where it has one
  issueExternalId: string
  commentExternalId?: string                     // when it hangs off a comment
  url: string                                    // the idempotency key (sourceId, url)
  title: string | null
  contentType?: string | null
  sizeBytes?: number | null
  /** `file`: bytes `fetchAsset` can read; `link`: a URL that is the whole attachment. */
  kind: 'file' | 'link'
  /** Found inside the description or a comment body, not on the issue's attachment list. */
  inline?: boolean
  createdAt: string
}

export type NormalisedItem = {
  …existing…
  /** `undefined` = not read on this call, leave what is stored. */
  comments?: NormalisedComment[]
  attachments?: NormalisedAttachment[]
}

export type SyncCheckpoint = {
  cursor?: string; since?: string; phase: 'initial' | 'incremental'
  /** The incremental comment lane: after the item pages, the comment pages. */
  lane?: 'items' | 'comments'
  commentsCursor?: string
  commentsSince?: string
}

export type SyncPage = {
  items: NormalisedItem[]
  /** Comments that changed independently of their issue (the comment lane). */
  comments?: NormalisedComment[]
  checkpoint: SyncCheckpoint
  hasMore: boolean
}

export type OutboundChange = { …existing…; labelIds?: string[] }   // provider label ids; replaces `fields.labels`
```

`src/adapter.ts` — optional capabilities, so an adapter that lacks one is
honest by omission rather than by a stub:

```ts
export type AssetStream = { stream: Readable; contentType: string | null; sizeBytes: number | null }

export interface BoardSourceAdapter {
  …existing…
  /** Hosts `fetchAsset` may dial; the streaming envelope refuses everything else. */
  readonly assetHosts?: readonly string[]
  fetchAsset?(ctx: ConnectionContext, asset: { url: string }): Promise<AssetStream | null>   // null = gone (404)
  createComment?(ctx, container, item: { externalId; externalKey }, body: string): Promise<NormalisedComment>
  updateComment?(ctx, container, comment: { externalId }, body: string): Promise<NormalisedComment>
  deleteComment?(ctx, container, comment: { externalId }): Promise<void>
}

export type ContainerDescription = {
  states; fields; members
  /** First-class now; an adapter that lists labels here stops declaring a `labels` field. */
  labels?: NormalisedItemLabel[]
}

export type WebhookDelivery = {
  …existing…
  /** `item` (default): the ids are issues. `label`: the container's labels changed; re-describe. */
  resource?: 'item' | 'label'
}
```

`src/http.ts` gains `sourceFetchStream({ url, allowedHosts, headers })`: the
same `safeFetch` envelope (`credentialsPresent: true`, `maxRedirects: 0`,
10 s to headers) but returning the body as a `Readable` under a **25 MiB**
cap enforced by a counting transform that destroys the stream and throws
`SourceAssetTooLargeError`. `sourceFetchJson` keeps its 1 MiB cap.

`itemFingerprint` is unchanged: comments and attachments are applied
independently of whether the item's mapped fields changed, so an `echo` or
`unchanged` item still has its comments applied. Label ids were already in
the hash; colour is not (a recolour upstream is applied when the label is
re-described, not per item).

### 4.2 Linear, in full

`packages/board-source-linear/src/queries.ts`:

- `ISSUE_FIELDS` adds `labels { nodes { id name color } }` and
  `attachments(first: 25) { nodes { id title subtitle url sourceType createdAt updatedAt } }`.
- `COMMENT_FIELDS = id body createdAt updatedAt editedAt url user { id name email } botActor { id name } issue { id } parent { id }`.
- `ISSUES_BY_ID_QUERY` (the webhook path) additionally selects
  `comments(first: 50) { nodes { ${COMMENT_FIELDS} } }` — at most 100 issues
  per call, so the nested selection stays inside Linear's complexity budget.
- `ISSUES_PAGE_QUERY` does **not** nest comments (100 issues × N comments is
  what blows the budget); the comment lane is a flat query instead:
  `COMMENTS_PAGE_QUERY: comments(first: 100, after: $after, filter: { issue: { team: { id: { eq: $teamId } } }, updatedAt: { gt: $updatedAfter } }, orderBy: updatedAt, includeArchived: true) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage endCursor } }`.
- `TEAM_DESCRIPTION_QUERY` selects `labels(first: 250) { nodes { id name color parent { id name } } }`
  and the adapter also queries workspace-level labels
  (`issueLabels(filter: { team: { null: true } })`) since a team's issues may
  carry either. A label in a group is named `Group / Name`.
- `COMMENT_CREATE_MUTATION`, `COMMENT_UPDATE_MUTATION`, `COMMENT_DELETE_MUTATION`
  (`commentCreate(input:{issueId, body})`, `commentUpdate(id, input:{body})`,
  `commentDelete(id)`), each returning `${COMMENT_FIELDS}`.

`fetchPage` becomes a two-lane state machine over the checkpoint. Lane
`items` pages issues exactly as today; when it reports `hasNextPage: false`
it switches the checkpoint to lane `comments` with `commentsSince = since`
(the `initial` phase walks comments from the epoch) and returns `hasMore:
true`; lane `comments` pages the flat query and, on its last page, resets to
lane `items` with both `since` values advanced. `worker/src/control/board-source-sync.ts`
already loops "until `hasMore` is false, persisting the checkpoint after
every page", so it needs no lane knowledge; its ≤100-pages-per-job bound
stays.

`normalise.ts`: labels carry `color`; `attachments` maps the issue's
attachment list to `kind: 'file'` when the URL host is in `assetHosts`
(`uploads.linear.app`) and `kind: 'link'` otherwise (a GitHub PR, a Figma
link — Linear attachments are frequently URLs); `inlineAssetsIn(markdown,
issueExternalId, commentExternalId?)` scans `![…](url)` and `[…](url)` for
`assetHosts` URLs and yields `kind: 'file', inline: true` attachments for
descriptions and comment bodies; a `botActor` comment has `author: null`
and `authorDisplay: botActor.name`.

`adapter.ts`:

- `assetHosts: ['uploads.linear.app']`; `fetchAsset` sends the credential
  as the `authorization` header through `sourceFetchStream`. **To verify
  live**, as the boards as-built did for webhooks: Linear documents its
  uploads as private and readable with the same authorization; if a live run
  answers 403 and points at signed URLs, the asset step records the failure
  and the description keeps the Linear URL — nothing else breaks.
- `describeContainer` returns `labels` and drops the `labels` entry from
  `fields` (the `estimate` field stays).
- `buildWebhookCreateInput` registers `resourceTypes: ['Issue', 'Comment', 'IssueLabel']`
  and the comment above it changes to say why. `parseWebhook`: a `Comment`
  delivery yields `externalIds: [data.issueId]` and `resource: 'item'` (the
  processor re-reads the issue with its comments through `fetchItems`; a
  `remove` action additionally carries `removedCommentExternalIds` so a
  deletion — which polling cannot see — lands); an `IssueLabel` delivery
  yields `resource: 'label'` and no ids.
- `applyChange` maps `change.labelIds` to `input.labelIds` and drops the
  `fields.labels` arm; `createComment`/`updateComment`/`deleteComment` run the
  three mutations and normalise the echo.

### 4.3 Audience — the §5.3 objection, answered per provider

The original design kept comments out because "an upstream comment can have
a narrower audience than the issue". That is true of exactly one provider
feature:

| Provider | Comment audience | Decision |
|---|---|---|
| Linear | everyone who can see the issue (no per-comment restriction) | import under the task's project scope |
| GitHub | everyone who can see the issue | import |
| Trello | everyone who can see the card | import |
| Jira | everyone who can see the issue **unless** the comment carries `visibility: { type: role\|group }` | import only comments with no `visibility`; the adapter marks the others `restricted: true` and the apply step drops them |

So a stored comment never has an audience narrower than its task, and the
task's project scope is its basis — the same basis `ticket_read` already
stamps. The boards design's §5.3 sentence is superseded by this table
(recorded in that folder's as-built, §6.5 of delivery).

### 4.4 Applying — `packages/team-admin`

`board-source-apply.ts` (item) is extended; comments and assets get their own
module `board-source-apply-activity.ts` because they are not part of the
item's fingerprint decision:

1. **Labels (native).** `applyFieldMappings` gains a `native:labels` arm
   fed from `item.labels` (not `fields.labels`): every label is upserted
   into `task_labels` by `(sourceId, externalId)` with `name`, `normalized_name`,
   `color ?? '#6b7280'`, `ON CONFLICT (project_id, normalized_name)` adopting
   the existing Nessie label (a person who made *Bug* before connecting
   Linear keeps their label; it becomes source-owned). Then the task's
   **source-owned** links (labels with this `sourceId`) are replaced by the
   item's set; Nessie-only links are untouched. A change writes
   `labels_changed { bySourceId, added, removed }`. `describeContainer`'s
   `labels` (attach, `resource: 'label'` webhooks, and every initial sync)
   upsert names and colours the same way, so a recolour upstream reaches the
   pill without any issue changing. The attach flow
   (`api/src/routes/board-sources/sources.ts:258-277`) seeds
   `{ externalKey: 'labels', target: 'native:labels' }` and creates no
   definition for a field the adapter no longer declares.
2. **Comments.** `applyInboundComments(prisma, source, comments)` — per
   comment: skip `restricted`; resolve the task by `(sourceId,
   issueExternalId)` (a comment on an issue the mirror does not hold is
   skipped, not queued — the issue arrives first on the next item page);
   resolve the author through `BoardSourceIdentityLink` and the email
   matcher in `board-source-identity.ts` (comment authors join the People
   table exactly as assignees do); upsert by `(sourceId, externalId)`:
   insert → `comment_added { bySourceId, externalId }` and `task.activity`;
   existing with an older `externalUpdatedAt` → update `body`, `editedAt`;
   `removedCommentExternalIds` → soft delete. Authors an identity link maps
   to a person or agent get `authorUserId`/`authorAgentId`; the rest keep
   `externalAuthorExternalId` + `externalAuthorDisplay` (or
   `authorDisplay` for bots). `reprojectIdentityLinks` (as-built §5.8) also
   re-attributes stored comments when a mapping appears later.
3. **Assets.** `applyInboundAssets(prisma, source, attachments)` upserts
   `task_external_assets` by `(sourceId, externalUrl)`: `kind: 'link'` →
   `status: 'link'`; `kind: 'file'` → `status: 'pending'` (attempts 0).
   Then, in the same job, `fetchPendingAssets(source, { limit: 20 })`
   streams each pending asset through `adapter.fetchAsset` into
   `FileService.store({ organizationId, uploaderId: null, taskId,
   taskCommentId?, filename: title ?? last path segment, mime: contentType ??
   'application/octet-stream', attribution })` — attribution built the way
   the sync worker already builds it for its other stores
   (`worker/src/control/dashboard-refresh.ts` precedent), never a hand-built
   literal — and marks `stored` with `attachmentId`. A refusal or timeout
   increments `attempts`, records `lastError`, and after **3** attempts sets
   `failed`; `null` (gone upstream) sets `failed` at once. Twenty per job
   bounds a first sync of a media-heavy team; the rest are picked up by the
   following polls because `pending` rows are re-listed every job.
4. **Rewriting text.** Once an inline asset is `stored`, its provider URL in
   `Task.detail` or the comment `body` is replaced, string-exact, by
   `/api/attachments/<attachmentId>` (§1.5). Because `applyInboundItem`
   writes `detail` from the provider on every changed item, that write goes
   through `rewriteProviderUrls(text, storedAssets)` in the same transaction,
   so a stored image never flips back to the provider URL. `pending` and
   `failed` assets leave the provider URL in place, and the renderer shows
   it as an ordinary remote image (which only the connection owner can
   open) — the Attachments list is where a `failed` row names the problem.

### 4.5 Idempotency and failure, in one table

| Thing | Key on re-sync | Changed upstream | Deleted upstream | Fetch failed |
|---|---|---|---|---|
| Label | `(sourceId, externalId)` | name/colour updated on the next describe or item | not detected in v1 — a label Linear deleted stays until a person deletes it (no false removals) | — |
| Task↔label link | source-owned subset replaced per item | applied | applied (absent from the item) | — |
| Comment | `(sourceId, externalId)` | applied when `externalUpdatedAt` is newer | webhook `remove` → soft delete; polling alone never deletes | lane error = ordinary sync failure (health, backoff) |
| File / inline image | `(sourceId, externalUrl)` | a new URL is a new asset | not detected; the stored copy stays | `attempts` 1→3 then `failed`; provider URL kept in text; `failed` row in Attachments |

Nothing here changes a source's `healthState`: an asset that cannot be
fetched is one row's problem, not the source's, and the row says so.

### 4.6 Write-back

`writeMode` governs, as in §5.7 of the boards design:

| Action on a mirrored ticket | `read_only` | `read_write` |
|---|---|---|
| Add a comment | created **locally**, `external: null`, shown as *Nessie only* — a comment is Nessie's own conversation about the ticket, not a mapped field | `adapter.createComment` first; row written from the echo with `externalId` |
| Edit / delete an imported comment | refused `SOURCE_READ_ONLY` | `updateComment` / `deleteComment` first, when the adapter implements them; else `COMMENT_NOT_WRITABLE` |
| Set source-owned labels | refused `SOURCE_READ_ONLY` | `applyChange(link, { labelIds })`, mirror from the echo |
| Set Nessie-only labels | local, always | local, always |
| Attach a file | local, always | local, always — **files do not go upstream in v1** (Linear's `attachmentCreate` needs a URL Linear can fetch and ours are private; open question 2) |
| Edit the description | as today (`detail` writes back) | as today, with `OutboundChange.description = rewriteForProvider(detail, assets)`: a stored asset maps back to its `externalUrl`; a Nessie-born image becomes an absolute `https://<admin origin>/api/attachments/<id>` link that needs a Nessie sign-in — stated gap, same open question |

A `read_only` refusal names the remedy in the same sentence the title edit
uses: *"Linear owns this ticket's labels. Switch the source to read & write in
Settings → Sources to change them from here."*

### 4.7 The other three adapters

Each implements the same contract with its own flat lanes; each stays under
its own unit tests over recorded fixtures. Linear is the acceptance test;
these ship in wave 2 (delivery §6.3, agent F).

| Provider | Labels | Comments | Files |
|---|---|---|---|
| GitHub Issues | `labels[].color` (hex without `#`, prefixed) | lane: `GET /repos/{o}/{r}/issues/comments?since=&sort=updated&direction=asc&per_page=100` (flat, all issues); webhook `issue_comment` → issue number | inline only: `github.com/user-attachments/assets/…` and `user-images.githubusercontent.com` in bodies; `assetHosts` those two; `fetchAsset` with the installation token (private repos need it) |
| Trello | `labels[].color` name → the fixed Trello palette table in `normalise.ts` (`null` colour → default) | `GET /1/boards/{id}/actions?filter=commentCard&since=` (flat); webhook `commentCard` actions | `GET /1/boards/{id}/cards?attachments=true` → `kind` by `isUpload`; `assetHosts: ['trello.com', 'api.trello.com']`; Trello upload URLs need the key/token as query parameters, so `fetchAsset` appends them (never logged) |
| Jira Cloud | bare strings, no colour → `externalId = name`, default colour, recoloured by a person | `fields.comment.comments[]` embedded (`maxResults` 100 per issue; `fetchItems` for more), ADF → Markdown-ish text through the existing `adfToText`; `restricted: Boolean(comment.visibility)`; webhook `comment_created/updated/deleted` → issue key | `fields.attachment[]` → `kind: 'file'` with `content` URL; `assetHosts: ['api.atlassian.com']`; inline ADF `media` nodes are **not** resolved in v1 (ADF media ids are not URLs) — the Attachments list carries the file instead |

GitHub Projects v2 items inherit their content issue's comments through the
issues lane and get nothing of their own.

### 4.8 Identity

Comment authors go through the one place a provider identity meets a Nessie
identity, `BoardSourceIdentityLink`, keyed by `(provider, externalTenantKey,
externalUserId)`; the email matcher runs over comment authors on every page
as it does over assignees, so somebody who only ever commented also appears
in the People table with *Matched by email*. Nothing promotes an author to a
`User`; an unmapped author is displayed from the provider's data with the
provider glyph, exactly as an unmapped assignee is.
