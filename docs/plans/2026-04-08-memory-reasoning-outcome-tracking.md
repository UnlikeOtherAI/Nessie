# Memory, Reasoning, and Outcome Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a complete memory system to Nessie with pgvector-powered semantic search, structured reasoning capture, thought linking/supersession, and outcome tracking that transforms stored facts into accumulated experience.

**Architecture:** New `packages/memory` package with embedding, metadata extraction, reasoning extraction, and search. Prisma schema extended with `Thought`, `ThoughtReasoning`, `ThoughtLink`, and `ThoughtAuditLog` models. Raw SQL migration for pgvector extension and HNSW index. API routes exposed via Fastify. MCP tools for agent-facing capture/search. All scoped to the existing multi-tenant hierarchy (org/project/team/channel).

**Tech Stack:** PostgreSQL + pgvector (HNSW), OpenAI `text-embedding-3-small` (1536-dim), `gpt-4o-mini` (JSON mode for metadata/reasoning extraction), Prisma ORM, Zod schemas, Fastify routes, existing `@nessie/runtime` pg pool and model client.

---

## Task 1: Enable pgvector Extension

**Files:**
- Create: `api/prisma/migrations/20260408200000_enable_pgvector/migration.sql`

**Step 1: Write the migration SQL**

```sql
-- Enable pgvector extension for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;
```

**Step 2: Run the migration**

```bash
cd api && npx prisma migrate resolve --applied 20260408200000_enable_pgvector
```

Or if applying fresh:

```bash
cd api && npx prisma migrate dev --name enable_pgvector
```

Verify: `psql $DATABASE_URL -c "SELECT extname FROM pg_extension WHERE extname = 'vector';"` should return `vector`.

**Step 3: Commit**

```bash
git add api/prisma/migrations/20260408200000_enable_pgvector/
git commit -m "feat(db): enable pgvector extension"
```

---

## Task 2: Add Memory Models to Prisma Schema

**Files:**
- Modify: `api/prisma/schema.prisma`

**Step 1: Add enums**

After the existing `MessageRole` enum, add:

```prisma
enum ThoughtOwnerType {
  user
  agent
  service
}

enum ThoughtVisibility {
  private
  channel
  team
  project
  organization
}

enum SensitivityTier {
  normal
  sensitive
  restricted
}

enum ReasoningType {
  decision
  evaluation
  constraint
  pattern
  correction
  validation
}

enum OutcomeStatus {
  pending
  successful
  partially
  failed
  superseded
}

enum ThoughtLinkRelation {
  supersedes
  derived_from
  contradicts
  supports
  relates_to
}
```

**Step 2: Add the Thought model**

After the `QueueJob` model, add:

```prisma
model Thought {
  id              String              @id @default(uuid()) @db.Uuid
  content         String
  contentHash     String              @map("content_hash")
  /// pgvector column — managed via raw SQL migration, not Prisma-native
  /// Prisma reads/writes via $queryRawUnsafe
  /// embedding       Unsupported("vector(1536)")

  // Ownership
  ownerId         String              @map("owner_id")
  ownerType       ThoughtOwnerType    @map("owner_type")

  // Tenant scoping (hard org boundary)
  organizationId  String              @map("organization_id") @db.Uuid
  organization    Organization        @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  projectId       String?             @map("project_id") @db.Uuid
  teamId          String?             @map("team_id") @db.Uuid
  channelId       String?             @map("channel_id") @db.Uuid
  threadId        String?             @map("thread_id") @db.Uuid

  // Classification
  visibility      ThoughtVisibility   @default(private)
  sensitivityTier SensitivityTier     @default(normal) @map("sensitivity_tier")
  importance      Float               @default(0.5)

  // LLM-extracted metadata
  metadata        Json?

  // Lifecycle
  deletedAt       DateTime?           @map("deleted_at")
  createdAt       DateTime            @default(now()) @map("created_at")
  updatedAt       DateTime            @updatedAt @map("updated_at")

  // Relations
  reasonings      ThoughtReasoning[]
  linksFrom       ThoughtLink[]       @relation("ThoughtLinksFrom")
  linksTo         ThoughtLink[]       @relation("ThoughtLinksTo")
  auditLogs       ThoughtAuditLog[]

  @@index([organizationId, visibility, createdAt])
  @@index([organizationId, ownerId, ownerType])
  @@index([contentHash])
  @@index([channelId, createdAt])
  @@map("thoughts")
}

model ThoughtReasoning {
  id              String          @id @default(uuid()) @db.Uuid
  thoughtId       String          @map("thought_id") @db.Uuid
  thought         Thought         @relation(fields: [thoughtId], references: [id], onDelete: Cascade)

  reasoningType   ReasoningType   @map("reasoning_type")
  alternatives    Json?
  criteria        Json?
  constraints     Json?
  tradeoffs       String?
  confidence      Float?
  reasoning       String

  // Who contributed this reasoning
  actorType       String          @map("actor_type")
  actorId         String          @map("actor_id")

  // Outcome tracking
  outcome         OutcomeStatus   @default(pending)
  outcomeNotes    String?         @map("outcome_notes")
  outcomeAt       DateTime?       @map("outcome_at")

  // Scoping (denormalized from thought for direct queries)
  organizationId  String          @map("organization_id") @db.Uuid

  createdAt       DateTime        @default(now()) @map("created_at")
  updatedAt       DateTime        @updatedAt @map("updated_at")

  @@index([thoughtId, createdAt])
  @@index([organizationId, outcome])
  @@index([organizationId, actorId])
  @@map("thought_reasonings")
}

model ThoughtLink {
  id         String              @id @default(uuid()) @db.Uuid
  sourceId   String              @map("source_id") @db.Uuid
  targetId   String              @map("target_id") @db.Uuid
  source     Thought             @relation("ThoughtLinksFrom", fields: [sourceId], references: [id], onDelete: Cascade)
  target     Thought             @relation("ThoughtLinksTo", fields: [targetId], references: [id], onDelete: Cascade)
  relation   ThoughtLinkRelation
  metadata   Json?
  createdAt  DateTime            @default(now()) @map("created_at")

  @@unique([sourceId, targetId, relation])
  @@index([targetId])
  @@map("thought_links")
}

model ThoughtAuditLog {
  id         String   @id @default(uuid()) @db.Uuid
  thoughtId  String   @map("thought_id") @db.Uuid
  thought    Thought  @relation(fields: [thoughtId], references: [id], onDelete: Cascade)
  action     String
  actorType  String   @map("actor_type")
  actorId    String   @map("actor_id")
  diff       Json?
  createdAt  DateTime @default(now()) @map("created_at")

  @@index([thoughtId, createdAt])
  @@map("thought_audit_logs")
}
```

**Step 3: Add the Organization relation back-link**

In the `Organization` model, add:

```prisma
  thoughts  Thought[]
```

After `channels  Channel[]`.

**Step 4: Generate migration**

```bash
cd api && npx prisma migrate dev --name add_memory_models
```

**Step 5: Commit**

```bash
git add api/prisma/
git commit -m "feat(db): add Thought, ThoughtReasoning, ThoughtLink, ThoughtAuditLog models"
```

---

## Task 3: Raw SQL Migration for Vector Column and Indexes

Prisma does not natively support `vector(1536)`. We add the column, HNSW index, tsvector column, and the `match_thoughts_scoped` function via raw SQL applied after the Prisma migration.

**Files:**
- Create: `api/prisma/migrations/20260408200200_vector_columns_and_search/migration.sql`

**Step 1: Write the raw SQL migration**

```sql
-- Add vector embedding column (Prisma can't model this)
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Add precomputed tsvector for full-text search
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content, ''))
  ) STORED;

-- HNSW index for vector similarity search
CREATE INDEX IF NOT EXISTS idx_thoughts_embedding
  ON thoughts USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS idx_thoughts_search_vector
  ON thoughts USING GIN (search_vector);

-- GIN index on metadata JSONB
CREATE INDEX IF NOT EXISTS idx_thoughts_metadata
  ON thoughts USING GIN (metadata);

-- Scoped semantic search function
-- Returns thoughts the caller can see, ranked by cosine similarity
CREATE OR REPLACE FUNCTION match_thoughts_scoped(
  query_embedding vector(1536),
  match_org_id uuid,
  match_user_id text,
  match_threshold float DEFAULT 0.3,
  match_limit int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  content text,
  content_hash text,
  owner_id text,
  owner_type text,
  organization_id uuid,
  project_id uuid,
  team_id uuid,
  channel_id uuid,
  thread_id uuid,
  visibility text,
  sensitivity_tier text,
  importance float8,
  metadata jsonb,
  created_at timestamptz,
  similarity float8
)
LANGUAGE sql STABLE
AS $$
  SELECT
    t.id,
    t.content,
    t.content_hash,
    t.owner_id,
    t.owner_type::text,
    t.organization_id,
    t.project_id,
    t.team_id,
    t.channel_id,
    t.thread_id,
    t.visibility::text,
    t.sensitivity_tier::text,
    t.importance,
    t.metadata,
    t.created_at,
    1 - (t.embedding <=> query_embedding) AS similarity
  FROM thoughts t
  WHERE t.organization_id = match_org_id
    AND t.deleted_at IS NULL
    AND t.embedding IS NOT NULL
    AND 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (
      -- Private: owner only
      (t.visibility = 'private' AND t.owner_id = match_user_id)
      -- Channel: caller is a member of the channel
      OR (t.visibility = 'channel' AND EXISTS (
        SELECT 1 FROM channel_members cm
        WHERE cm.channel_id = t.channel_id AND cm.user_id::text = match_user_id
      ))
      -- Team: caller is a member of the team
      OR (t.visibility = 'team' AND EXISTS (
        SELECT 1 FROM team_members tm
        WHERE tm.team_id = t.team_id AND tm.user_id::text = match_user_id
      ))
      -- Project: caller is a member of the project
      OR (t.visibility = 'project' AND EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = t.project_id AND pm.user_id::text = match_user_id
      ))
      -- Organization: caller is a member of the org
      OR (t.visibility = 'organization' AND EXISTS (
        SELECT 1 FROM organization_members om
        WHERE om.organization_id = t.organization_id AND om.user_id::text = match_user_id
      ))
    )
  ORDER BY similarity DESC
  LIMIT match_limit;
$$;
```

**Step 2: Apply the migration**

```bash
cd api && npx prisma migrate resolve --applied 20260408200200_vector_columns_and_search
```

Or run manually against the database:

```bash
psql $DATABASE_URL -f api/prisma/migrations/20260408200200_vector_columns_and_search/migration.sql
```

**Step 3: Commit**

```bash
git add api/prisma/migrations/20260408200200_vector_columns_and_search/
git commit -m "feat(db): add vector column, HNSW index, tsvector, scoped search function"
```

---

## Task 4: Create `packages/memory` Package Scaffold

**Files:**
- Create: `packages/memory/package.json`
- Create: `packages/memory/tsconfig.json`
- Create: `packages/memory/tsconfig.build.json`
- Create: `packages/memory/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "@nessie/memory",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "lint": "eslint src --max-warnings 0",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@nessie/schemas": "workspace:*",
    "pg": "^8.16.3"
  },
  "devDependencies": {
    "@types/pg": "^8.15.5"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

**Step 3: Create tsconfig.build.json**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts"]
}
```

**Step 4: Create src/index.ts**

```typescript
export { captureThought, type CaptureThoughtInput } from './capture.js'
export { searchThoughts, type SearchThoughtsInput, type SearchResult } from './search.js'
export { getEmbedding } from './embed.js'
export { extractMetadata, type ThoughtMetadata } from './extract-metadata.js'
export { extractReasoning, type ReasoningExtraction } from './extract-reasoning.js'
export { computeFingerprint } from './fingerprint.js'
export {
  recordOutcome,
  type RecordOutcomeInput,
  linkThoughts,
  type LinkThoughtsInput,
} from './lifecycle.js'
```

**Step 5: Install dependencies and verify**

```bash
pnpm install
cd packages/memory && pnpm typecheck
```

Note: This will fail until we create the source files. That's expected.

**Step 6: Commit**

```bash
git add packages/memory/
git commit -m "feat(memory): scaffold @nessie/memory package"
```

---

## Task 5: Implement Embedding Function

**Files:**
- Create: `packages/memory/src/embed.ts`

**Step 1: Write the embedding module**

```typescript
import type { Pool } from 'pg'

export type EmbeddingConfig = {
  apiKey: string
  model?: string
  baseUrl?: string
}

const DEFAULT_MODEL = 'text-embedding-3-small'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export const getEmbedding = async (
  text: string,
  config: EmbeddingConfig,
): Promise<number[]> => {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const model = config.model ?? DEFAULT_MODEL

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: text.slice(0, 8000),
      model,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Embedding API error ${response.status}: ${errorText}`)
  }

  const result = (await response.json()) as {
    data: { embedding: number[] }[]
  }

  const embedding = result.data[0]?.embedding
  if (!embedding) {
    throw new Error('No embedding returned from API')
  }

  return embedding
}
```

**Step 2: Commit**

```bash
git add packages/memory/src/embed.ts
git commit -m "feat(memory): add embedding function (text-embedding-3-small)"
```

---

## Task 6: Implement Content Fingerprinting

**Files:**
- Create: `packages/memory/src/fingerprint.ts`

**Step 1: Write the fingerprint module**

```typescript
import { createHash } from 'node:crypto'

/**
 * SHA-256 fingerprint for dedup.
 * Normalizes: lowercase, trim, collapse whitespace.
 */
export const computeFingerprint = (content: string): string => {
  const normalized = content.toLowerCase().trim().replace(/\s+/g, ' ')
  return createHash('sha256').update(normalized).digest('hex')
}
```

**Step 2: Commit**

```bash
git add packages/memory/src/fingerprint.ts
git commit -m "feat(memory): add SHA-256 content fingerprinting for dedup"
```

---

## Task 7: Implement Metadata Extraction

**Files:**
- Create: `packages/memory/src/extract-metadata.ts`

**Step 1: Write the metadata extraction module**

```typescript
export type ThoughtMetadata = {
  people: string[]
  topics: string[]
  type: 'note' | 'task' | 'idea' | 'observation' | 'decision' | 'constraint' | 'preference'
  actionItems: string[]
  dates: string[]
}

export type ExtractionConfig = {
  apiKey: string
  model?: string
  baseUrl?: string
}

const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

const EXTRACTION_PROMPT = `Extract structured metadata from this text. Return JSON only.

Fields:
- people: array of names mentioned (empty array if none)
- topics: array of key subjects (2-5 items)
- type: one of "note", "task", "idea", "observation", "decision", "constraint", "preference"
- actionItems: array of action items (empty array if none)
- dates: array of dates or deadlines mentioned (empty array if none)

Text: `

export const extractMetadata = async (
  content: string,
  config: ExtractionConfig,
): Promise<ThoughtMetadata> => {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const model = config.model ?? DEFAULT_MODEL

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You extract structured metadata from text. Return valid JSON only.' },
        { role: 'user', content: `${EXTRACTION_PROMPT}${content.slice(0, 4000)}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 512,
      temperature: 0,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Metadata extraction error ${response.status}: ${errorText}`)
  }

  const result = (await response.json()) as {
    choices: { message: { content: string } }[]
  }

  const raw = result.choices[0]?.message.content
  if (!raw) {
    return { people: [], topics: [], type: 'note', actionItems: [], dates: [] }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ThoughtMetadata>
    return {
      people: Array.isArray(parsed.people) ? parsed.people : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      type: parsed.type ?? 'note',
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
      dates: Array.isArray(parsed.dates) ? parsed.dates : [],
    }
  } catch {
    return { people: [], topics: [], type: 'note', actionItems: [], dates: [] }
  }
}
```

**Step 2: Commit**

```bash
git add packages/memory/src/extract-metadata.ts
git commit -m "feat(memory): add LLM metadata extraction (gpt-4o-mini JSON mode)"
```

---

## Task 8: Implement Reasoning Extraction

This is the key differentiator. Extracts structured reasoning from decisions, preferences, and constraints.

**Files:**
- Create: `packages/memory/src/extract-reasoning.ts`

**Step 1: Write the reasoning extraction module**

```typescript
export type ReasoningExtraction = {
  hasReasoning: boolean
  reasoningType: 'decision' | 'evaluation' | 'constraint' | 'pattern' | 'correction' | 'validation'
  alternatives: string[] | null
  criteria: string[] | null
  constraints: string[] | null
  tradeoffs: string | null
  confidence: number
  reasoningSummary: string
}

export type ReasoningExtractionConfig = {
  apiKey: string
  model?: string
  baseUrl?: string
}

const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

const REASONING_PROMPT = `Analyze this text for decision reasoning. Return JSON only.

If the text contains a decision, preference, architectural choice, trade-off, evaluation, or constraint, extract:
{
  "hasReasoning": true,
  "reasoningType": "decision" | "evaluation" | "constraint" | "pattern" | "correction" | "validation",
  "alternatives": ["option A", "option B"] or null if not mentioned,
  "criteria": ["criterion 1", "criterion 2"] or null if not mentioned,
  "constraints": ["constraint 1"] or null if not mentioned,
  "tradeoffs": "what was gained vs sacrificed" or null,
  "confidence": 0.0 to 1.0 (how confident the decision-maker seems),
  "reasoningSummary": "one paragraph explaining the logic behind the decision"
}

If the text is a simple note, observation, or information without decision logic:
{ "hasReasoning": false, "reasoningType": "decision", "alternatives": null, "criteria": null, "constraints": null, "tradeoffs": null, "confidence": 0, "reasoningSummary": "" }

Text: `

export const extractReasoning = async (
  content: string,
  config: ReasoningExtractionConfig,
): Promise<ReasoningExtraction> => {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const model = config.model ?? DEFAULT_MODEL

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You analyze text for decision reasoning. Return valid JSON only. Be precise about what alternatives were considered and what criteria drove the decision.',
        },
        { role: 'user', content: `${REASONING_PROMPT}${content.slice(0, 4000)}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1024,
      temperature: 0,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Reasoning extraction error ${response.status}: ${errorText}`)
  }

  const result = (await response.json()) as {
    choices: { message: { content: string } }[]
  }

  const raw = result.choices[0]?.message.content
  if (!raw) {
    return NO_REASONING
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReasoningExtraction>
    if (!parsed.hasReasoning) {
      return NO_REASONING
    }

    return {
      hasReasoning: true,
      reasoningType: parsed.reasoningType ?? 'decision',
      alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives : null,
      criteria: Array.isArray(parsed.criteria) ? parsed.criteria : null,
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : null,
      tradeoffs: typeof parsed.tradeoffs === 'string' ? parsed.tradeoffs : null,
      confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
      reasoningSummary: parsed.reasoningSummary ?? '',
    }
  } catch {
    return NO_REASONING
  }
}

const NO_REASONING: ReasoningExtraction = {
  hasReasoning: false,
  reasoningType: 'decision',
  alternatives: null,
  criteria: null,
  constraints: null,
  tradeoffs: null,
  confidence: 0,
  reasoningSummary: '',
}
```

**Step 2: Commit**

```bash
git add packages/memory/src/extract-reasoning.ts
git commit -m "feat(memory): add structured reasoning extraction from decisions"
```

---

## Task 9: Implement Thought Capture Pipeline

The main capture function: fingerprint, dedup, embed, extract metadata, extract reasoning — all in parallel where possible.

**Files:**
- Create: `packages/memory/src/capture.ts`

**Step 1: Write the capture module**

```typescript
import type { Pool } from 'pg'
import { computeFingerprint } from './fingerprint.js'
import { getEmbedding, type EmbeddingConfig } from './embed.js'
import { extractMetadata, type ThoughtMetadata, type ExtractionConfig } from './extract-metadata.js'
import { extractReasoning, type ReasoningExtraction, type ReasoningExtractionConfig } from './extract-reasoning.js'

export type CaptureThoughtInput = {
  content: string
  ownerId: string
  ownerType: 'user' | 'agent' | 'service'
  organizationId: string
  projectId?: string
  teamId?: string
  channelId?: string
  threadId?: string
  visibility?: 'private' | 'channel' | 'team' | 'project' | 'organization'
  sensitivityTier?: 'normal' | 'sensitive' | 'restricted'
  importance?: number
}

export type CapturedThought = {
  id: string
  content: string
  contentHash: string
  metadata: ThoughtMetadata | null
  reasoning: ReasoningExtraction | null
  isDuplicate: boolean
  createdAt: string
}

export type CaptureConfig = {
  pool: Pool
  embedding: EmbeddingConfig
  extraction: ExtractionConfig
}

export const captureThought = async (
  input: CaptureThoughtInput,
  config: CaptureConfig,
): Promise<CapturedThought> => {
  const contentHash = computeFingerprint(input.content)

  // Check for duplicate
  const dupCheck = await config.pool.query(
    `SELECT id, metadata FROM thoughts
     WHERE content_hash = $1 AND organization_id = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [contentHash, input.organizationId],
  )

  if (dupCheck.rows.length > 0) {
    const existing = dupCheck.rows[0] as { id: string; metadata: unknown }
    return {
      id: existing.id,
      content: input.content,
      contentHash,
      metadata: existing.metadata as ThoughtMetadata | null,
      reasoning: null,
      isDuplicate: true,
      createdAt: '',
    }
  }

  // Run embedding + metadata extraction + reasoning extraction in parallel
  const [embedding, metadata, reasoning] = await Promise.all([
    getEmbedding(input.content, config.embedding).catch(() => null),
    extractMetadata(input.content, config.extraction).catch(() => null),
    extractReasoning(input.content, config.extraction as ReasoningExtractionConfig).catch(() => null),
  ])

  // Insert thought
  const visibility = input.visibility ?? 'private'
  const sensitivityTier = input.sensitivityTier ?? 'normal'
  const importance = input.importance ?? 0.5

  const insertResult = await config.pool.query(
    `INSERT INTO thoughts (
      id, content, content_hash, embedding, owner_id, owner_type,
      organization_id, project_id, team_id, channel_id, thread_id,
      visibility, sensitivity_tier, importance, metadata, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), $1, $2, $3::vector, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, now(), now()
    ) RETURNING id, created_at`,
    [
      input.content,
      contentHash,
      embedding ? `[${embedding.join(',')}]` : null,
      input.ownerId,
      input.ownerType,
      input.organizationId,
      input.projectId ?? null,
      input.teamId ?? null,
      input.channelId ?? null,
      input.threadId ?? null,
      visibility,
      sensitivityTier,
      importance,
      metadata ? JSON.stringify(metadata) : null,
    ],
  )

  const thoughtId = (insertResult.rows[0] as { id: string }).id
  const createdAt = (insertResult.rows[0] as { created_at: string }).created_at

  // If reasoning was extracted, insert a ThoughtReasoning record
  if (reasoning?.hasReasoning) {
    await config.pool.query(
      `INSERT INTO thought_reasonings (
        id, thought_id, reasoning_type, alternatives, criteria, constraints,
        tradeoffs, confidence, reasoning, actor_type, actor_id, outcome,
        organization_id, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, 'pending',
        $11, now(), now()
      )`,
      [
        thoughtId,
        reasoning.reasoningType,
        reasoning.alternatives ? JSON.stringify(reasoning.alternatives) : null,
        reasoning.criteria ? JSON.stringify(reasoning.criteria) : null,
        reasoning.constraints ? JSON.stringify(reasoning.constraints) : null,
        reasoning.tradeoffs,
        reasoning.confidence,
        reasoning.reasoningSummary,
        input.ownerType,
        input.ownerId,
        input.organizationId,
      ],
    )
  }

  // Write audit log
  await config.pool.query(
    `INSERT INTO thought_audit_logs (id, thought_id, action, actor_type, actor_id, created_at)
     VALUES (gen_random_uuid(), $1, 'created', $2, $3, now())`,
    [thoughtId, input.ownerType, input.ownerId],
  )

  return {
    id: thoughtId,
    content: input.content,
    contentHash,
    metadata,
    reasoning,
    isDuplicate: false,
    createdAt: String(createdAt),
  }
}
```

**Step 2: Commit**

```bash
git add packages/memory/src/capture.ts
git commit -m "feat(memory): implement thought capture pipeline with parallel extraction"
```

---

## Task 10: Implement Semantic Search

**Files:**
- Create: `packages/memory/src/search.ts`

**Step 1: Write the search module**

```typescript
import type { Pool } from 'pg'
import { getEmbedding, type EmbeddingConfig } from './embed.js'

export type SearchThoughtsInput = {
  query: string
  organizationId: string
  userId: string
  threshold?: number
  limit?: number
  includeReasoning?: boolean
}

export type SearchResult = {
  id: string
  content: string
  ownerType: string
  visibility: string
  importance: number
  metadata: unknown
  similarity: number
  createdAt: string
  reasoning?: {
    reasoningType: string
    alternatives: unknown
    criteria: unknown
    confidence: number
    reasoning: string
    outcome: string
    outcomeNotes: string | null
  }[]
}

export type SearchConfig = {
  pool: Pool
  embedding: EmbeddingConfig
}

export const searchThoughts = async (
  input: SearchThoughtsInput,
  config: SearchConfig,
): Promise<SearchResult[]> => {
  const queryEmbedding = await getEmbedding(input.query, config.embedding)
  const embeddingStr = `[${queryEmbedding.join(',')}]`

  const threshold = input.threshold ?? 0.3
  const limit = input.limit ?? 10

  const results = await config.pool.query(
    `SELECT * FROM match_thoughts_scoped($1::vector, $2, $3, $4, $5)`,
    [embeddingStr, input.organizationId, input.userId, threshold, limit],
  )

  const thoughts = results.rows as Array<{
    id: string
    content: string
    owner_type: string
    visibility: string
    importance: number
    metadata: unknown
    similarity: number
    created_at: string
  }>

  if (!input.includeReasoning) {
    return thoughts.map((t) => ({
      id: t.id,
      content: t.content,
      ownerType: t.owner_type,
      visibility: t.visibility,
      importance: t.importance,
      metadata: t.metadata,
      similarity: t.similarity,
      createdAt: String(t.created_at),
    }))
  }

  // Batch-load reasoning for all found thoughts
  const thoughtIds = thoughts.map((t) => t.id)
  if (thoughtIds.length === 0) {
    return []
  }

  const reasoningResults = await config.pool.query(
    `SELECT thought_id, reasoning_type, alternatives, criteria, confidence,
            reasoning, outcome, outcome_notes
     FROM thought_reasonings
     WHERE thought_id = ANY($1)
     ORDER BY created_at ASC`,
    [thoughtIds],
  )

  const reasoningByThought = new Map<string, SearchResult['reasoning']>()
  for (const r of reasoningResults.rows as Array<{
    thought_id: string
    reasoning_type: string
    alternatives: unknown
    criteria: unknown
    confidence: number
    reasoning: string
    outcome: string
    outcome_notes: string | null
  }>) {
    const existing = reasoningByThought.get(r.thought_id) ?? []
    existing.push({
      reasoningType: r.reasoning_type,
      alternatives: r.alternatives,
      criteria: r.criteria,
      confidence: r.confidence,
      reasoning: r.reasoning,
      outcome: r.outcome,
      outcomeNotes: r.outcome_notes,
    })
    reasoningByThought.set(r.thought_id, existing)
  }

  return thoughts.map((t) => ({
    id: t.id,
    content: t.content,
    ownerType: t.owner_type,
    visibility: t.visibility,
    importance: t.importance,
    metadata: t.metadata,
    similarity: t.similarity,
    createdAt: String(t.created_at),
    reasoning: reasoningByThought.get(t.id),
  }))
}
```

**Step 2: Commit**

```bash
git add packages/memory/src/search.ts
git commit -m "feat(memory): implement scoped semantic search with reasoning loading"
```

---

## Task 11: Implement Lifecycle Operations (Outcome Tracking, Linking, Supersession)

**Files:**
- Create: `packages/memory/src/lifecycle.ts`

**Step 1: Write the lifecycle module**

```typescript
import type { Pool } from 'pg'

// ─── Outcome Tracking ───────────────────────────────────────────────────────

export type RecordOutcomeInput = {
  thoughtId: string
  outcome: 'successful' | 'partially' | 'failed' | 'superseded'
  outcomeNotes?: string
  actorType: string
  actorId: string
}

export const recordOutcome = async (
  input: RecordOutcomeInput,
  pool: Pool,
): Promise<void> => {
  // Update all reasoning records for this thought
  const result = await pool.query(
    `UPDATE thought_reasonings
     SET outcome = $1, outcome_notes = $2, outcome_at = now(), updated_at = now()
     WHERE thought_id = $3 AND outcome = 'pending'
     RETURNING id`,
    [input.outcome, input.outcomeNotes ?? null, input.thoughtId],
  )

  // Audit log
  await pool.query(
    `INSERT INTO thought_audit_logs (id, thought_id, action, actor_type, actor_id, diff, created_at)
     VALUES (gen_random_uuid(), $1, 'outcome_recorded', $2, $3, $4, now())`,
    [
      input.thoughtId,
      input.actorType,
      input.actorId,
      JSON.stringify({
        outcome: input.outcome,
        outcomeNotes: input.outcomeNotes,
        reasoningsUpdated: result.rowCount,
      }),
    ],
  )
}

// ─── Thought Linking ────────────────────────────────────────────────────────

export type LinkThoughtsInput = {
  sourceId: string
  targetId: string
  relation: 'supersedes' | 'derived_from' | 'contradicts' | 'supports' | 'relates_to'
  metadata?: Record<string, unknown>
  actorType: string
  actorId: string
}

export const linkThoughts = async (
  input: LinkThoughtsInput,
  pool: Pool,
): Promise<string> => {
  const result = await pool.query(
    `INSERT INTO thought_links (id, source_id, target_id, relation, metadata, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
     ON CONFLICT (source_id, target_id, relation) DO NOTHING
     RETURNING id`,
    [input.sourceId, input.targetId, input.relation, input.metadata ? JSON.stringify(input.metadata) : null],
  )

  const linkId = (result.rows[0] as { id: string } | undefined)?.id ?? ''

  // If superseding, mark the target's reasoning as superseded
  if (input.relation === 'supersedes') {
    await pool.query(
      `UPDATE thought_reasonings
       SET outcome = 'superseded', outcome_notes = 'Superseded by thought ' || $1, outcome_at = now(), updated_at = now()
       WHERE thought_id = $2 AND outcome = 'pending'`,
      [input.sourceId, input.targetId],
    )
  }

  // Audit log on source
  await pool.query(
    `INSERT INTO thought_audit_logs (id, thought_id, action, actor_type, actor_id, diff, created_at)
     VALUES (gen_random_uuid(), $1, 'linked', $2, $3, $4, now())`,
    [
      input.sourceId,
      input.actorType,
      input.actorId,
      JSON.stringify({ relation: input.relation, targetId: input.targetId }),
    ],
  )

  return linkId
}

// ─── Experience Query ───────────────────────────────────────────────────────

export type ExperienceStats = {
  totalDecisions: number
  successful: number
  failed: number
  pending: number
  successRate: number
}

/**
 * Get decision quality stats for an actor or org.
 */
export const getExperienceStats = async (
  organizationId: string,
  actorId: string | null,
  pool: Pool,
): Promise<ExperienceStats> => {
  const whereClause = actorId
    ? 'WHERE organization_id = $1 AND actor_id = $2'
    : 'WHERE organization_id = $1'
  const params = actorId ? [organizationId, actorId] : [organizationId]

  const result = await pool.query(
    `SELECT
       count(*) FILTER (WHERE outcome != 'pending') AS total_decisions,
       count(*) FILTER (WHERE outcome = 'successful') AS successful,
       count(*) FILTER (WHERE outcome = 'failed') AS failed,
       count(*) FILTER (WHERE outcome = 'pending') AS pending
     FROM thought_reasonings
     ${whereClause}`,
    params,
  )

  const row = result.rows[0] as {
    total_decisions: string
    successful: string
    failed: string
    pending: string
  }

  const total = Number(row.total_decisions)
  const successful = Number(row.successful)
  const failed = Number(row.failed)
  const pending = Number(row.pending)

  return {
    totalDecisions: total,
    successful,
    failed,
    pending,
    successRate: total > 0 ? successful / total : 0,
  }
}
```

**Step 2: Commit**

```bash
git add packages/memory/src/lifecycle.ts
git commit -m "feat(memory): implement outcome tracking, thought linking, experience stats"
```

---

## Task 12: Add Memory Schemas to `@nessie/schemas`

**Files:**
- Modify: `packages/schemas/src/index.ts`

**Step 1: Add branded ID and schemas**

At the top, after the existing branded ID schemas, add:

```typescript
export const ThoughtIdSchema = createUuidBrandSchema<'ThoughtId'>()
export type ThoughtId = z.infer<typeof ThoughtIdSchema>
export const parseThoughtId = (value: string): ThoughtId => ThoughtIdSchema.parse(value)
```

At the bottom of the file, add:

```typescript
// ─── Memory Schemas ─────────────────────────────────────────────────────────

export const ThoughtVisibilitySchema = z.enum([
  'private',
  'channel',
  'team',
  'project',
  'organization',
])
export type ThoughtVisibility = z.infer<typeof ThoughtVisibilitySchema>

export const SensitivityTierSchema = z.enum(['normal', 'sensitive', 'restricted'])
export type SensitivityTier = z.infer<typeof SensitivityTierSchema>

export const ReasoningTypeSchema = z.enum([
  'decision',
  'evaluation',
  'constraint',
  'pattern',
  'correction',
  'validation',
])
export type ReasoningType = z.infer<typeof ReasoningTypeSchema>

export const OutcomeStatusSchema = z.enum([
  'pending',
  'successful',
  'partially',
  'failed',
  'superseded',
])
export type OutcomeStatus = z.infer<typeof OutcomeStatusSchema>

export const ThoughtLinkRelationSchema = z.enum([
  'supersedes',
  'derived_from',
  'contradicts',
  'supports',
  'relates_to',
])
export type ThoughtLinkRelation = z.infer<typeof ThoughtLinkRelationSchema>

export const CaptureThoughtBodySchema = z.object({
  content: z.string().min(1).max(50000),
  visibility: ThoughtVisibilitySchema.optional(),
  sensitivityTier: SensitivityTierSchema.optional(),
  importance: z.number().min(0).max(1).optional(),
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  threadId: ThreadIdSchema.optional(),
})
export type CaptureThoughtBody = z.infer<typeof CaptureThoughtBodySchema>

export const SearchThoughtsQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  threshold: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  includeReasoning: z.coerce.boolean().optional(),
})
export type SearchThoughtsQuery = z.infer<typeof SearchThoughtsQuerySchema>

export const RecordOutcomeBodySchema = z.object({
  outcome: OutcomeStatusSchema.exclude(['pending']),
  outcomeNotes: z.string().max(5000).optional(),
})
export type RecordOutcomeBody = z.infer<typeof RecordOutcomeBodySchema>

export const LinkThoughtsBodySchema = z.object({
  targetId: ThoughtIdSchema,
  relation: ThoughtLinkRelationSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type LinkThoughtsBody = z.infer<typeof LinkThoughtsBodySchema>

export const ThoughtRecordSchema = z.object({
  id: ThoughtIdSchema,
  content: z.string(),
  ownerType: z.string(),
  visibility: ThoughtVisibilitySchema,
  importance: z.number(),
  metadata: z.unknown().nullable(),
  similarity: z.number().optional(),
  createdAt: TimestampSchema,
  reasoning: z.array(z.object({
    reasoningType: ReasoningTypeSchema,
    alternatives: z.unknown().nullable(),
    criteria: z.unknown().nullable(),
    confidence: z.number(),
    reasoning: z.string(),
    outcome: OutcomeStatusSchema,
    outcomeNotes: z.string().nullable(),
  })).optional(),
})
export type ThoughtRecord = z.infer<typeof ThoughtRecordSchema>

export const ExperienceStatsSchema = z.object({
  totalDecisions: z.number(),
  successful: z.number(),
  failed: z.number(),
  pending: z.number(),
  successRate: z.number(),
})
export type ExperienceStats = z.infer<typeof ExperienceStatsSchema>
```

**Step 2: Verify**

```bash
cd packages/schemas && pnpm typecheck
```

**Step 3: Commit**

```bash
git add packages/schemas/src/index.ts
git commit -m "feat(schemas): add memory, reasoning, and outcome tracking schemas"
```

---

## Task 13: Add Memory API Routes to Fastify

**Files:**
- Create: `api/src/services/thoughts.ts`
- Modify: `api/src/index.ts` (register routes)

**Step 1: Write the thoughts service**

```typescript
import type { Pool } from 'pg'
import {
  captureThought,
  searchThoughts,
  recordOutcome,
  linkThoughts,
  getExperienceStats,
  type CaptureConfig,
  type SearchConfig,
} from '@nessie/memory'

export type ThoughtServiceDeps = {
  pool: Pool
  captureConfig: CaptureConfig
  searchConfig: SearchConfig
}

export const createThoughtService = (deps: ThoughtServiceDeps) => ({
  capture: (input: Parameters<typeof captureThought>[0]) =>
    captureThought(input, deps.captureConfig),

  search: (input: Parameters<typeof searchThoughts>[0]) =>
    searchThoughts(input, deps.searchConfig),

  recordOutcome: (input: Parameters<typeof recordOutcome>[0]) =>
    recordOutcome(input, deps.pool),

  link: (input: Parameters<typeof linkThoughts>[0]) =>
    linkThoughts(input, deps.pool),

  experienceStats: (organizationId: string, actorId: string | null) =>
    getExperienceStats(organizationId, actorId, deps.pool),
})
```

**Step 2: Register the routes in `api/src/index.ts`**

After the existing route registrations, add the memory endpoints. The exact insertion point depends on the existing route structure. The pattern follows the existing Fastify route style in `api/src/index.ts`:

```typescript
// ─── Memory Routes ──────────────────────────────────────────────────────────

// POST /api/thoughts — capture a new thought
app.post('/api/thoughts', async (req, reply) => {
  const claims = await requireAuth(req, reply)
  if (!claims) return

  const body = parseInput(CaptureThoughtBodySchema, req.body, reply)
  if (!body) return

  const result = await thoughtService.capture({
    content: body.content,
    ownerId: claims.sub,
    ownerType: 'user',
    organizationId: claims.org,
    projectId: body.projectId,
    teamId: body.teamId,
    channelId: body.channelId,
    threadId: body.threadId,
    visibility: body.visibility,
    sensitivityTier: body.sensitivityTier,
    importance: body.importance,
  })

  reply.code(result.isDuplicate ? 200 : 201).send(createApiResponse(result))
})

// POST /api/thoughts/search — semantic search
app.post('/api/thoughts/search', async (req, reply) => {
  const claims = await requireAuth(req, reply)
  if (!claims) return

  const body = parseInput(SearchThoughtsQuerySchema, req.body, reply)
  if (!body) return

  const results = await thoughtService.search({
    query: body.query,
    organizationId: claims.org,
    userId: claims.sub,
    threshold: body.threshold,
    limit: body.limit,
    includeReasoning: body.includeReasoning,
  })

  reply.send(createApiResponse(results))
})

// PUT /api/thoughts/:id/outcome — record outcome
app.put('/api/thoughts/:id/outcome', async (req, reply) => {
  const claims = await requireAuth(req, reply)
  if (!claims) return

  const thoughtId = (req.params as { id: string }).id
  const body = parseInput(RecordOutcomeBodySchema, req.body, reply)
  if (!body) return

  await thoughtService.recordOutcome({
    thoughtId,
    outcome: body.outcome,
    outcomeNotes: body.outcomeNotes,
    actorType: 'user',
    actorId: claims.sub,
  })

  reply.send(createApiResponse({ recorded: true }))
})

// POST /api/thoughts/:id/link — link two thoughts
app.post('/api/thoughts/:id/link', async (req, reply) => {
  const claims = await requireAuth(req, reply)
  if (!claims) return

  const sourceId = (req.params as { id: string }).id
  const body = parseInput(LinkThoughtsBodySchema, req.body, reply)
  if (!body) return

  const linkId = await thoughtService.link({
    sourceId,
    targetId: body.targetId,
    relation: body.relation,
    metadata: body.metadata,
    actorType: 'user',
    actorId: claims.sub,
  })

  reply.code(201).send(createApiResponse({ linkId }))
})

// GET /api/experience/stats — get decision quality stats
app.get('/api/experience/stats', async (req, reply) => {
  const claims = await requireAuth(req, reply)
  if (!claims) return

  const actorId = (req.query as { actorId?: string }).actorId ?? null
  const stats = await thoughtService.experienceStats(claims.org, actorId)

  reply.send(createApiResponse(stats))
})
```

**Step 3: Initialize the thought service**

Near the top of `api/src/index.ts` where other services are initialized, add the thought service setup using the existing pg pool and model client configuration. The `captureConfig` and `searchConfig` read from the same env vars already used by the model client.

**Step 4: Verify**

```bash
cd api && pnpm typecheck
```

**Step 5: Commit**

```bash
git add api/src/services/thoughts.ts api/src/index.ts
git commit -m "feat(api): add memory routes — capture, search, outcome, link, experience stats"
```

---

## Task 14: Add MCP Tools for Memory

Extend the MCP server to expose `capture_thought`, `search_thoughts`, `record_outcome`, and `link_thoughts` tools.

**Files:**
- Modify: `src/mcp/server.ts`

**Step 1: Add tool definitions to the TOOLS array**

```typescript
{
  name: 'capture_thought',
  description: 'Store a thought, decision, or observation in long-term memory. Extracts metadata and reasoning automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The thought content to store' },
      visibility: { type: 'string', enum: ['private', 'channel', 'team', 'project', 'organization'], description: 'Who can see this thought' },
      importance: { type: 'number', description: '0.0-1.0 importance score' },
    },
    required: ['content'],
  },
},
{
  name: 'search_thoughts',
  description: 'Search long-term memory using natural language. Returns relevant thoughts with reasoning and outcome history.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language search query' },
      limit: { type: 'number', description: 'Max results (default 10)' },
      includeReasoning: { type: 'boolean', description: 'Include decision reasoning and outcomes' },
    },
    required: ['query'],
  },
},
{
  name: 'record_outcome',
  description: 'Record whether a past decision was successful, partially successful, or failed. Builds experience over time.',
  inputSchema: {
    type: 'object',
    properties: {
      thoughtId: { type: 'string', description: 'ID of the thought/decision to evaluate' },
      outcome: { type: 'string', enum: ['successful', 'partially', 'failed'], description: 'How did this decision work out?' },
      outcomeNotes: { type: 'string', description: 'Details about the outcome' },
    },
    required: ['thoughtId', 'outcome'],
  },
},
{
  name: 'link_thoughts',
  description: 'Create a relationship between two thoughts. Use "supersedes" when a new decision replaces an old one.',
  inputSchema: {
    type: 'object',
    properties: {
      sourceId: { type: 'string', description: 'ID of the source thought' },
      targetId: { type: 'string', description: 'ID of the target thought' },
      relation: { type: 'string', enum: ['supersedes', 'derived_from', 'contradicts', 'supports', 'relates_to'] },
    },
    required: ['sourceId', 'targetId', 'relation'],
  },
},
{
  name: 'experience_stats',
  description: 'Get decision quality statistics — how many decisions were successful vs failed. Shows accumulated experience.',
  inputSchema: {
    type: 'object',
    properties: {
      actorId: { type: 'string', description: 'Optional: filter to a specific user/agent' },
    },
  },
},
```

**Step 2: Add tool handlers**

In the switch statement that handles tool calls, add cases for each new tool. Each handler calls the corresponding function from `@nessie/memory`.

**Step 3: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat(mcp): add memory tools — capture, search, outcome, link, experience stats"
```

---

## Task 15: Build, Lint, Verify

**Step 1: Install all dependencies**

```bash
pnpm install
```

**Step 2: Build all packages**

```bash
pnpm -r build
```

**Step 3: Typecheck all packages**

```bash
pnpm -r typecheck
```

**Step 4: Lint**

```bash
pnpm -r lint
```

**Step 5: Fix any issues**

Address any lint or type errors. Common expected issues:
- Unused imports in modified files
- Missing `@nessie/memory` dependency in `api/package.json` — add `"@nessie/memory": "workspace:*"`
- Missing `@nessie/memory` dependency in `worker/package.json` if the worker needs it

**Step 6: Commit**

```bash
git add -A
git commit -m "fix: resolve build and lint issues across all packages"
```

---

## Task 16: Integration Smoke Test

Manual verification that the full pipeline works end-to-end.

**Step 1: Start the database**

```bash
docker compose up -d postgres
```

**Step 2: Run migrations**

```bash
cd api && npx prisma migrate deploy
```

**Step 3: Verify pgvector is enabled**

```bash
psql $DATABASE_URL -c "SELECT extname FROM pg_extension WHERE extname = 'vector';"
```

Expected: one row with `vector`.

**Step 4: Verify tables exist**

```bash
psql $DATABASE_URL -c "\dt thoughts; \dt thought_reasonings; \dt thought_links; \dt thought_audit_logs;"
```

**Step 5: Verify the scoped search function exists**

```bash
psql $DATABASE_URL -c "SELECT proname FROM pg_proc WHERE proname = 'match_thoughts_scoped';"
```

**Step 6: Start the API**

```bash
pnpm --filter @nessie/api dev
```

**Step 7: Test capture**

```bash
curl -X POST http://localhost:4317/api/thoughts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <session_token>" \
  -d '{
    "content": "We chose Fastify over Express because of 2x JSON serialization performance and built-in schema validation. Express was considered but rejected due to middleware chain overhead.",
    "visibility": "organization",
    "importance": 0.8
  }'
```

Expected: 201 response with `id`, `metadata` (topics, type=decision), `reasoning` (alternatives: Express, criteria: performance/validation).

**Step 8: Test search**

```bash
curl -X POST http://localhost:4317/api/thoughts/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <session_token>" \
  -d '{
    "query": "why did we choose our API framework?",
    "includeReasoning": true
  }'
```

Expected: returns the Fastify thought with reasoning attached.

**Step 9: Test outcome recording**

```bash
curl -X PUT http://localhost:4317/api/thoughts/<thought_id>/outcome \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <session_token>" \
  -d '{
    "outcome": "successful",
    "outcomeNotes": "p99 latency 12ms, zero framework-related incidents in 6 months"
  }'
```

Expected: 200 with `{ recorded: true }`.

**Step 10: Test experience stats**

```bash
curl http://localhost:4317/api/experience/stats \
  -H "Authorization: Bearer <session_token>"
```

Expected: `{ totalDecisions: 1, successful: 1, failed: 0, pending: 0, successRate: 1.0 }`.

**Step 11: Commit verification note**

```bash
git add -A
git commit -m "docs: verify memory system integration smoke test passes"
```

---

## Summary of What Gets Built

| Component | What | Where |
|---|---|---|
| **pgvector** | Vector extension + HNSW index | Prisma migration (raw SQL) |
| **Thought** | Core memory unit with embedding, visibility, sensitivity | `api/prisma/schema.prisma` |
| **ThoughtReasoning** | Structured decision reasoning with outcome tracking | `api/prisma/schema.prisma` |
| **ThoughtLink** | Supersession/relationship graph between thoughts | `api/prisma/schema.prisma` |
| **ThoughtAuditLog** | Append-only audit trail for all mutations | `api/prisma/schema.prisma` |
| **Embedding** | `text-embedding-3-small` via OpenAI API | `packages/memory/src/embed.ts` |
| **Fingerprinting** | SHA-256 content dedup | `packages/memory/src/fingerprint.ts` |
| **Metadata extraction** | `gpt-4o-mini` JSON mode: topics, type, people, action items | `packages/memory/src/extract-metadata.ts` |
| **Reasoning extraction** | `gpt-4o-mini` JSON mode: alternatives, criteria, confidence | `packages/memory/src/extract-reasoning.ts` |
| **Capture pipeline** | Parallel embed + extract + reason, dedup, audit | `packages/memory/src/capture.ts` |
| **Semantic search** | Scoped vector search with membership checks | `packages/memory/src/search.ts` |
| **Outcome tracking** | Record success/failure, compute experience stats | `packages/memory/src/lifecycle.ts` |
| **Thought linking** | Supersession chains, auto-mark superseded reasoning | `packages/memory/src/lifecycle.ts` |
| **Zod schemas** | Type-safe API contracts | `packages/schemas/src/index.ts` |
| **API routes** | 5 Fastify endpoints | `api/src/services/thoughts.ts` + `api/src/index.ts` |
| **MCP tools** | 5 agent-facing tools | `src/mcp/server.ts` |
| **Access control** | `match_thoughts_scoped()` SQL function | Raw SQL migration |
