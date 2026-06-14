# Knowledge Base Requirements (Deterministic + Ephemeral Retrieval)

> Status: target-state design.

> Phase B note: this document now describes the future external facade/source tier.
> The first-party authoring envelope is implemented as `KnowledgeSpace`,
> hierarchical `KnowledgePage`, append-only `KnowledgePageVersion`, and `PageLabel`
> behind the `KnowledgeProvider` interface.

## 1) Decision on terminology

This is a **knowledge retrieval + summarization system** with optional RAG-like generation.

It does not need to be full end-to-end RAG in the first phase. The practical model is:

- persist sources and deterministic metadata
- query compact summaries first
- fetch full content only when explicitly requested
- generate synthesized answers only in a bounded, explicit `search.summary` or task-specific path

This avoids context pollution while still allowing sub-agents to discover what exists and retrieve only the needed material.

## 2) Functional requirements

1. The system must ingest external knowledge sources without requiring code changes.
2. Supported source kinds:
   - local folder
   - local file path
   - local MCP documentation endpoint
   - remote URL
3. Ingestion should capture short structured summaries at source level.
4. Every source must expose a canonical metadata record before use:
   - `sourceUri`
   - `kind`
   - `mimeType`
   - `title`
   - `summary`
   - `language`
   - `tags`
   - `updatedAt`
   - `checksum`
5. Search should be available in two modes:
   - deterministic index search (tag/keyword/path/project scoped, stable ordering)
   - semantic search option (optional, if vector index exists)
6. Search should be bounded and compact by default:
   - small `k` with short snippets
   - no automatic full-document injection
   - explicit `read` required to get full body
   - project-aware default scope using `projectId`
7. Full content access should support read-level policy checks.
   - cross-project reads require explicit sharing/allow policy.
8. Thread-local ephemeral retrieval must be supported:
   - short-lived shortlist by thread
   - query-derived narrowing, TTL-limited
   - private per-thread cache by actor/channel context
9. Search endpoints must support deterministic pagination and tie-breakers.
10. Tool calls need explainable provenance for UI and audit:
    - whether content is from summary or full read
    - result source IDs
    - team/channel-level visibility reason
    - project-level visibility reason must be explicit in every response

## 2.1) Data model

### Prisma models

```prisma
model KnowledgeSource {
  id              String   @id @default(uuid())
  organizationId  String   @map("organization_id")
  projectId       String   @map("project_id")
  sourceUri       String   @map("source_uri")
  kind            String   // 'file' | 'folder' | 'url' | 'mcp'
  mimeType        String?  @map("mime_type")
  title           String
  summary         String?
  language        String?  // BCP-47
  tags            String[]
  checksum        String?
  status          String   @default("active") // 'active' | 'indexing' | 'error' | 'removed'
  createdBy       String   @map("created_by")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  organization    Organization @relation(fields: [organizationId], references: [id])
  documents       KnowledgeDocument[]
  shareGrants     KnowledgeShareGrant[]

  @@index([organizationId, projectId])
  @@index([tags], type: Gin)
  @@index([updatedAt])
}

model KnowledgeDocument {
  id              String   @id @default(uuid())
  sourceId        String   @map("source_id")
  title           String
  summary         String?
  body            String?  // full content, nullable for large docs stored externally
  bodyRef         String?  @map("body_ref") // object storage reference for large docs
  language        String?
  checksum        String?
  chunkIndex      Int?     @map("chunk_index") // for chunked documents
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  source          KnowledgeSource @relation(fields: [sourceId], references: [id], onDelete: Cascade)

  @@index([sourceId])
  @@index([updatedAt])
}

model KnowledgeShareGrant {
  id                String   @id @default(uuid())
  sourceId          String   @map("source_id")
  targetProjectId   String   @map("target_project_id")
  actions           String[] // ['search', 'read']
  grantedBy         String   @map("granted_by")
  grantedAt         DateTime @default(now()) @map("granted_at")
  expiresAt         DateTime? @map("expires_at")

  source            KnowledgeSource @relation(fields: [sourceId], references: [id], onDelete: Cascade)

  @@unique([sourceId, targetProjectId])
}
```

### Response types (for `packages/schemas`)

```ts
type KnowledgeSourceId = string & { readonly __brand: 'KnowledgeSourceId' };
type KnowledgeDocId = string & { readonly __brand: 'KnowledgeDocId' };

type KnowledgeSourceRecord = {
  id: KnowledgeSourceId;
  projectId: string;
  sourceUri: string;
  kind: 'file' | 'folder' | 'url' | 'mcp';
  mimeType?: string;
  title: string;
  summary?: string;
  language?: string;
  tags: string[];
  checksum?: string;
  status: 'active' | 'indexing' | 'error' | 'removed';
  createdAt: string;
  updatedAt: string;
};

type KnowledgeSearchHit = {
  docId: KnowledgeDocId;
  sourceId: KnowledgeSourceId;
  title: string;
  snippet: string;
  score?: number;
  visibilityReason: string;
  policyChainTrace?: string[];
};

type KnowledgeReadPayload = {
  docId: KnowledgeDocId;
  sourceId: KnowledgeSourceId;
  title: string;
  body: string;
  language?: string;
  summary?: string;
  visibilityReason: string;
  policyChainTrace?: string[];
};

type KnowledgeSearchSummary = {
  answer: string;
  citations: Array<{
    docId: KnowledgeDocId;
    spans: string[];
    score: number;
  }>;
  visibilityReason: string;
  policyChainTrace?: string[];
};
```

## 3) Suggested tool contract

Single logical tool family: `knowledge-base` with action enum.

Required actions:

- `link`: register a new source or a source container
- `reindex`: refresh existing source metadata/index chunks
- `summarize`: compute/refresh source summary at ingestion time
- `search`: return compact hit list and provenance
- `read`: fetch specific document content by `docId`
- `search.summary`: return a compact synthetic answer with citations (`docId`, sentence spans, score)

Recommended action payload shape:

```ts
// accessContext uses the canonical AccessContext from shared-type-contracts-spec.md section 9.
// Do not duplicate the shape here — import from packages/schemas.
interface KnowledgeBaseToolInput {
  action: "link" | "reindex" | "summarize" | "search" | "read" | "search.summary";
  accessContext: AccessContext;
  projectId?: string;
  sourceUri?: string;
  sourceType?: "file" | "folder" | "url" | "mcp";
  docId?: string;
  query?: string;
  topK?: number;
  limit?: number;
  cursor?: string;
  sort?: "updatedAtDesc" | "scoreDesc" | "titleAsc";
  tags?: string[];
  ephemeral?: boolean;
  // Visibility is enforced by the policy engine (see policy-enforcement-spec.md §6.7), not by a filter param.
  // Callers cannot bypass policy by requesting a specific scope.
  ttlMs?: number;
}
```

## 3.1) HTTP contracts

Preferred interface is per-action endpoints. A shared action body schema is acceptable when client transport is constrained.

- `POST /api/knowledge-base/link`
- `POST /api/knowledge-base/reindex`
- `POST /api/knowledge-base/summarize`
- `POST /api/knowledge-base/search`
  - accepts `topK`, `limit`, `cursor`, `sort`, `accessContext`, `tags`
  - matching is case-insensitive substring (`ILIKE '%q%'`) over page **title**,
    **summary**, and **label** names, backed by `pg_trgm` GIN trigram indexes so it
    does not sequentially scan every page (`native-search.ts`). Page `metadata` is
    not searched (it was unindexable JSON-cast text).
- `POST /api/knowledge-base/read`
  - accepts `docId`, `projectId`, `accessContext`
- `POST /api/knowledge-base/search-summary` (or `search.summary`)
  - returns compact cited summary
- `POST /api/knowledge-base/projects/{projectId}/share`
  - source-level grant: `{ accessContext, targetProjectId, sourceId, actions: ['search','read'], expiresAt }`
  - shares an entire knowledge source to the target project; document-level sharing is not supported in Phase 3
- `POST /api/knowledge-base/projects/{projectId}/preflight`
  - evaluates cross-project visibility and returns actionable deny reasons.

## 4) Deterministic behavior contract

- Default order: `updatedAt DESC, score DESC, title ASC, docId ASC`.
- Full deterministic mode: cursor derived from `(updatedAt, id)` per shared-type-contracts-spec.md section 3. When a non-default sort is active (e.g. `scoreDesc`), the cursor includes `(sortValue, updatedAt, id)` for stable tie-breaking.
- Search results should not include full docs unless `read` is requested.
- Every response should include pagination and cache metadata to keep clients resumable.
- Thread-level `ephemeral` search must include `ttlMs` and source cap metadata.
- Every search/read response must include `visibilityReason` and `policyChainTrace` for explainability.

## 5) Security and policy constraints

- Per-team/channel/project per-action roles for search/read/summarize/reindex.
- Source allowlist/denylist for remote URLs and MCP hosts.
- Audit events use the canonical `AuditAction` names from [audit-trail-spec.md](./audit-trail-spec.md): `kb.source.linked`, `kb.search.executed`, `kb.document.read`, `kb.search.summary`, `kb.source.reindexed`, `kb.source.removed`, `kb.share.granted`, `kb.share.revoked`.
- **Default policy rules.** The RBAC engine is deny-by-default, and the original
  default rule set seeded nothing for `knowledge_space` / `knowledge_page`, so
  every knowledge action returned `POLICY_DENIED` (the feature was unusable).
  `seedDefaultPolicies` now calls `ensureKnowledgeDefaultPolicies`, which grants
  org members (`*`) allow rules for `knowledge_space` view/create/edit and
  `knowledge_page` view/create/edit/read/search, and owners `knowledge_page`
  approve. It is idempotent and runs on every API start, so it backfills existing
  organizations. This is the coarse gate only — fine-grained per-space privacy
  is enforced separately in the knowledge provider (below).
- **Per-space access (fine-grained).** Each space has an access mode enforced in
  `packages/knowledge` (`access.ts`) and applied by every route handler:
  - **Public** — `visibility = organization`: any org member reads and writes.
  - **Public read-only** — `visibility = organization` + `writeRestricted`: any
    org member reads; only members + creator write.
  - **Project** — `visibility = project`: members of the space's `projectId`
    (via `ProjectMember`) read and write.
  - **Private** — `visibility = private`: only listed `KnowledgeSpaceMember`s +
    creator read and write.
  The creator always has full access. `listSpaces` filters to readable spaces;
  `getSpace`/page reads return 403 to non-readers; create/edit/delete/publish/
  move/restore return 403 to non-writers; search drops unreadable hits. The space
  record exposes the caller's effective `canWrite`. Non-human actors (agents /
  services) bypass per-user checks for now — refined in the MCP / agent-tools
  phase. (Schema: `KnowledgeSpace.writeRestricted` + `KnowledgeSpaceMember`.)

## 6) Fit with existing docs

- `knowledge-base` tool family in [04-interactive-tools.md](./agent-tool-capabilities/04-interactive-tools.md)
- `functionality.md` tool discovery and context-control sections
- `agent-communication-spec.md` search requirements

## 7) Release safety scenario

- Each project can bind an isolated knowledge corpus for release workflows.
- Searches and reads default to project namespace and may not leak across projects by default.
- Project-specific document links can be promoted/denied to other projects through explicit grants only.

## 8) Additional enterprise scenarios

- Regulated industries:
  - evidence-safe knowledge boundaries for legal/finance/health projects, with visibility reasons on every search/read result.
- Vendor operations:
  - customer-specific document namespaces with no cross-client leakage.
- MLOps and research:
  - model behavior docs and runbooks in project-local namespaces with strict read/share policy.
- Incident response:
  - playbook retrieval from channel-scoped sources and temporary escalation to protected project sources.
- Corporate knowledge curation:
  - onboarding packages can be imported once, then shared across teams only through explicit project grants.

## 9) Implementation note for current code

- No deterministic index/ephemeral cache exists yet.
- Current implementation has no `knowledge-base` runtime family or shared retrieval pipeline; this is target-state only.

## 9.1) Admin presentation (column UX)

The admin renders Knowledge in its own section, not inside the channels column.
On `/knowledge-base` the shell swaps the channels/DMs second column for a
dedicated `KnowledgeSidebarNav` (mirrors how `/agents` and the admin routes swap
that column):

- The second column is **only the Spaces list** — styled like the channels list
  (a collapsible "Spaces" header with a `+` that opens a centered
  `CreateSpaceDialog` modal). No pages live here.
- The main area uses shared `KnowledgePane` chrome (a 50px header with optional
  **Back** + title + centered view switcher + actions: **Upload file**, **New
  folder**, **New page**). The root browsing state is a filesystem-style view
  with folders first, then files, and every row starts with a folder/file icon:
  - The centered segmented switcher offers **Full page**, **Column**, and
    **Tree** views. **Column** is the default and the selected view persists in a
    cookie.
  - **Folders** sort first and carry a right chevron to signal they drill in. A
    folder is any page flagged `metadata.folder` (an empty folder created via
    **New folder**) **or** any page that already has children — so folders never
    disappear when emptied. **New folder** (a folder-plus icon in the pane
    actions) switches to **Column** view and drops a Finder-style inline name
    field into the active column; Enter creates the folder under the current
    parent, Escape cancels.
  - **Full page** shows one full-width folder at a time with breadcrumbs.
  - **Column** (`KnowledgeColumns`) renders each level as its own `admin-card`
    column laid left-to-right with horizontal scroll (not edge-to-edge sliding
    panes). The leftmost (space root) column is rendered a little wider than the
    rest. A draggable divider between columns sets a **single shared** column
    width applied to **all** columns at once — drag widens/narrows every column
    together (min 300px), persisted in the `nessie.admin.knowledgeColumnWidth`
    cookie.
  - **Tree** shows an expandable/collapsible hierarchy with animated branches.
  - **Page preview** (`PagePreview`) is a read-only document view (status, title,
    summary, labels, rendered body, and a Sub-pages section) rendered on a
    centered white "sheet" (`.kb-reader`) so content reads like paper — the sheet
    stays white with dark text under **any** theme. Selecting a document from any
    browsing view opens this document state; **Back** pops to the parent document
    or browser root.
  - **Editor** (`PageEditor`) and **version History** are full-width (the editor
    fills the whole main area), each with a Back button.

Shared state lives in `KnowledgeProvider`
(`admin/src/components/features/knowledge/`), which wraps the sidebar and the
route outlet on the Knowledge route. The page hierarchy is derived client-side
from the flat `GET /spaces/:id/pages` list via `parentPageId` and `childPageIds`.
That list **omits each page's latest-version body** (it can be large and the
tree/column/preview-header views never need it); the body is fetched on demand
via `GET /pages/:id` (`useKnowledgePage`) only when a document is opened, edited,
or its history is viewed. The editor is gated on that fetch, so it never
initialises from — and cannot save over — an empty body.

### First-visit seeding

When the spaces list loads empty, `KnowledgeProvider` seeds a **"General"** space
with one example page (`useSeedKnowledgeBase`, fired once via a ref guard). The
example page (`example-page.ts`) is authored as HTML and demonstrates the editor.

### Page bodies are rich HTML (TipTap)

Page bodies are stored as HTML. Editing uses a **TipTap** (ProseMirror) WYSIWYG —
`RichTextEditor` (StarterKit + Placeholder; toolbar for bold/italic/headings/
lists/quote/code/link). Rendering uses `RichTextContent`, a **read-only** TipTap
instance: parsing through the ProseMirror schema drops scripts, event handlers and
unknown tags, so stored HTML cannot execute as markup — the content never reaches
the DOM as a raw HTML string, so no separate sanitizer is needed. Editor and
reader share the `.kb-prose` token-themed styles in `admin/src/styles.css`; the
reader additionally wraps `.kb-prose` in the `.kb-reader` white sheet, which
redeclares the light token palette so prose stays legible on white regardless of
theme. Older plain-text bodies still render (as a paragraph).

### Annotations: comments + notes

Every page carries two kinds of annotation, backed by one model
(`KnowledgePageAnnotation`, table `knowledge_page_annotations`) discriminated by
`kind` + an optional text anchor:

- **Comments** (`kind: comment`, no anchor) — a page-level discussion
  (`CommentsSection`) rendered **below the body of every node**: under the
  document in `PagePreview` and under the preview in `FileNodeViewer`, so
  uploaded file nodes carry the same thread + reactions as documents (the
  annotation API is page-kind-agnostic). Newest first.
- **Notes** (`kind: note`, with anchor) — anchored to a quoted passage of the
  body. In the reader the passage is highlighted (a ProseMirror decoration via
  `notes/note-highlight-extension.ts`); **selecting text** shows a small, non-
  focus-stealing **"Add note"** button under the selection (`notes/PageNotesLayer
  .tsx`) — the selection stays intact so it can be copied, and only clicking the
  button opens the (autofocusing) composer. **Hovering or keyboard-focusing** an
  existing highlight opens a floating card on the right with the note, its author,
  and replies.

Comments and notes are rendered in the **channel-chat style** (`CommentThread`
+ `CommentRow`): avatar, author, timestamp, body, and a hover action bar
(`CommentActions`) that reuses the channel chrome (`admin-msg-row` /
`admin-msg-actions` / `reaction-pill` / `EmojiPickerPanel`). Both kinds support
one level of **replies**, a **resolve/reopen** state, **emoji reactions**, and
edit/delete by the author. Author is a user or an **agent** (a delegating
personal assistant authors as its owner with `delegatedByAgentId` recorded).
Reactions live in `knowledge_page_annotation_reactions` (toggled via
`POST /annotations/:id/reactions`), mirroring `MessageReaction`.

**Anchoring** is a W3C/Hypothesis-style **text-quote selector**
(`{ quote, prefix, suffix, startOffset }`) computed by the pure, shared
`@nessie/knowledge` `anchor` module (`htmlToPlainText` / `computeAnchor` /
`relocateAnchor`). Anchors are **re-located on every render** by matching the
quote (plus context) against the current body, so notes survive edits above them;
when the quoted text is gone the note is **orphaned** (still listed, no
highlight). The admin imports the anchor logic through the browser-safe
`@nessie/knowledge/anchor` subpath (no Prisma in the bundle).

**Access** inherits the page's space: anyone who can read the page can read, post,
and reply (`canReadSpace`); resolve/reopen needs write (`canWriteSpace`);
edit/delete is author-only. The same access-checked **annotations service**
(`packages/knowledge/src/annotations/`) backs both the REST routes
(`api/src/routes/knowledge-comments.ts`) and the agent tools, so enforcement
cannot drift. Mutations emit `kb.annotation.*` audit events. v1 has no realtime
push; the admin refetches via react-query invalidation on each mutation.

**Agent tools** (registered as builtins, so they appear in the tool grant matrix
automatically): `kb_comments_list`, `kb_comment_add`, `kb_comment_reply`,
`kb_comment_resolve`, `kb_note_add` (the agent supplies the exact quote; the
worker computes the anchor from the page body).

## 9b) File nodes & attachments (implemented)

Two file concepts live in the knowledge base alongside rich-text pages:

- **File nodes** — a `KnowledgePage` with `kind = file`, shown in the filesystem
  browser at the same level as documents and folders. Folders are not a `kind`:
  a folder is any page flagged `metadata.folder` (an empty folder from **New
  folder**) or any page that already has children. Each version is backed by an
  `Attachment`
  (`KnowledgePageVersion.attachmentId`); the admin shows a per-MIME FontAwesome
  icon, an inline viewer (image/PDF/text/CSV) or a typed download card, and an
  **Upload new version** action (a drag-drop / tap popup).
- **Attachments** — any node (document or file node) can carry extra files,
  linked via `Attachment.knowledgePageId` and surfaced in a right-hand
  **attachments drawer** (a docked rail on desktop, a full-screen sheet on
  mobile). Drag-and-drop onto the page preview adds an attachment; drag-and-drop
  onto the filesystem creates a file node; both show a dashed-square overlay with
  live upload progress.

All bytes flow through the single `@nessie/runtime` `FileService` (storage +
`Attachment` row + the `storage_usage_events` ledger). Uploads stream (5 GiB
cap), are gated by `Budget.storageLimitBytes` (per org/project/team), and every
store/delete keeps per-scope usage accurate. REST surface
(`api/src/routes/knowledge-base-files.ts`):

- `POST /api/knowledge-base/spaces/:spaceId/files` — create a file node
- `POST /api/knowledge-base/pages/:pageId/file-version` — upload a new version
- `GET /api/knowledge-base/pages/:pageId/versions/:versionId/download`
- `GET|POST /api/knowledge-base/pages/:pageId/attachments`
- `GET /api/knowledge-base/attachments/:id/download`, `DELETE …/attachments/:id`
- `POST /api/knowledge-base/pages/:pageId/convert-to-document` — turn a markdown
  file node into a document (see below)
- `GET /api/knowledge-base/pages/:pageId/versions/:versionId/zip` — list a zip's
  entries from its central directory (no extraction to disk), and
  `…/zip/entry?path=` to peek a single text entry (see below)

**Markdown is the native document format.** An uploaded `.md`/`.markdown`
(by extension or `text/markdown`) is **not** stored as a file blob: the upload
route renders it to HTML (`markdown-it`, `api/src/lib/markdown.ts`) and creates a
`kind = document` page with that body, so it gets the rich-text reader, the
WYSIWYG editor, comments/notes and version history — identical to a document
authored in-app. Import is capped at `MARKDOWN_IMPORT_MAX_BYTES` (5 MiB). Existing
markdown file nodes are migrated on open: `KnowledgeWorkspace` calls
`convert-to-document` (read the attachment text → HTML → new document version →
flip `kind` → drop the now-unused blob) and then renders the document.

**Type-aware file viewer.** Non-markdown file nodes keep the file-node path, with
the viewer inferred from the filename (`previewKindForFilename`): **images** and
**PDFs** preview via an authed object URL; **video** (mp4/webm/mov/…) and **audio**
(mp3/wav/ogg/flac/…) play inline via `<video>`/`<audio>` (which, like `<img>`,
can't execute scripts — only the PDF iframe needs a pinned MIME); **text/config**
(yaml, json, csv, a broad set of code/markup extensions + common extension-less
files like `Dockerfile`/`README`) render as a themed `<pre>` of the fetched bytes
(never an iframe, so a text/HTML file can't run scripts), capped at 512 KiB; **zip**
archives show a browsable entry list (`ZipContents.tsx`) where text entries can be
peeked inline; everything else (Office documents, other binaries) shows a typed
**Download to view** card. Zip listing reads the
whole archive into memory (`adm-zip`, capped at `ZIP_LIST_MAX_BYTES` = 64 MiB —
larger archives stay download-only); peeking decompresses only the requested
entry (capped at `ZIP_ENTRY_PEEK_MAX_BYTES` = 256 KiB).
- `GET /api/knowledge-base/storage-usage?scopeType=&scopeId=`

Agent/MCP built-in tools for the new file surface are a follow-up (agent parity).

## 10) Phase annotation

This spec targets **Phase 3**.

## 11) Cross-links

- [tool-registry-spec.md](./tool-registry-spec.md)
- [policy-enforcement-spec.md](./policy-enforcement-spec.md)
- [audit-trail-spec.md](./audit-trail-spec.md)
- [secret-management-spec.md](./secret-management-spec.md)
- [organization-governance-spec.md](./organization-governance-spec.md)
- [shared-type-contracts-spec.md](./shared-type-contracts-spec.md)
- [implementation-phases.md](./implementation-phases.md)
- [functionality.md](./functionality.md)
