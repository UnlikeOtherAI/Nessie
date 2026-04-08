# Knowledge Base Requirements (Deterministic + Ephemeral Retrieval)

> Status: target-state design.

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

## 6) Fit with existing docs

- `knowledge-base` tool family in [04-interactive-tools.md](./agent%20tool%20capabilities/04-interactive-tools.md)
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
