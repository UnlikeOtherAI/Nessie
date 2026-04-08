# OB1 Memory Concepts for Nessie

Analysis of the [Open Brain (OB1)](https://github.com/NateBJones-Projects/OB1) memory system, line-by-line code review, and how each concept maps to Nessie.

---

## 1. Core Architecture Comparison

### OB1's Stack
- **Database:** Supabase PostgreSQL + pgvector (remote, managed)
- **Embeddings:** OpenRouter -> `text-embedding-3-small` (1536-dim)
- **Metadata extraction:** OpenRouter -> `gpt-4o-mini` (JSON mode)
- **Protocol:** MCP over Streamable HTTP (Deno Edge Functions)
- **Auth:** Single shared `MCP_ACCESS_KEY` via header or query param

### Nessie's Existing Stack
- **Database:** PostgreSQL (Prisma ORM) for API; SQLite (bun:sqlite) for orchestrator
- **Embeddings:** None
- **Metadata extraction:** None
- **Protocol:** MCP server already running (40+ tools via `/src/mcp/`)
- **Auth:** Session-based JWT

### Gap
Nessie has the MCP transport, the database, and the tool infrastructure. It lacks the **vector storage**, **embedding pipeline**, **metadata extraction**, and **semantic search**. These are the four pieces OB1 contributes.

---

## 2. Code-Level Analysis: `server/index.ts` (Core MCP Server)

### Lines 1-15: Imports and Config

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
```

**Pattern:** Single Supabase client at module scope, reused across all tool handlers.

**Nessie equivalent:** We already have Prisma and a pg pool in `packages/runtime`. We'd add a pgvector-enabled table to our existing Prisma schema rather than spinning up a separate Supabase project. The embedding and metadata extraction functions would live in `packages/runtime` or a new `packages/memory` package.

### Lines 17-35: `getEmbedding()`

```typescript
async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  const d = await r.json();
  return d.data[0].embedding;
}
```

**What it does:** Takes raw text, sends to OpenRouter's embeddings endpoint, returns a 1536-dimensional float array.

**Key decisions:**
- Uses `text-embedding-3-small` (cheapest OpenAI embedding model, ~$0.02/M tokens)
- Routes through OpenRouter rather than OpenAI directly (vendor flexibility)
- Returns raw `number[]` -- no normalization, no truncation
- No batching -- one text per call

**Nessie adaptation:** We should use OpenAI directly since we already have the key for Realtime API. Or we use a local embedding model (e.g., `nomic-embed-text` via Ollama) to keep it zero-cost and offline-capable. The function signature stays the same -- it's just a `string -> number[]` pipe.

**Concern:** 1536-dim vectors are large. For a personal assistant with thousands of memories, this is fine. If we ever hit tens of thousands, consider `text-embedding-3-small` with `dimensions: 512` (supported natively).

### Lines 37-68: `extractMetadata()`

```typescript
async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    model: "openai/gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
      },
      { role: "user", content: text },
    ],
  });
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}
```

**What it does:** LLM-driven structured extraction. Takes freeform text, returns typed metadata object.

**Key decisions:**
- Uses `gpt-4o-mini` -- cheapest reasoning model, sufficient for classification
- `response_format: { type: "json_object" }` forces valid JSON output
- Graceful fallback on parse failure: `{ topics: ["uncategorized"], type: "observation" }`
- Five type categories: `observation`, `task`, `idea`, `reference`, `person_note`
- "Only extract what's explicitly there" prevents hallucinated metadata

**Nessie adaptation:** We can use gpt-4o-mini via OpenAI directly, or route through our existing orchestrator. The system prompt is the most valuable artifact here -- it defines the metadata schema that downstream filtering depends on. We should extend it with Nessie-specific types:
- `voice_note` -- captured from voice input
- `decision` -- captured during agent orchestration
- `context` -- background info about the user

### Lines 78-155: `search_thoughts` Tool

```typescript
server.registerTool("search_thoughts", {
  inputSchema: {
    query: z.string(),
    limit: z.number().optional().default(10),
    threshold: z.number().optional().default(0.5),
  },
}, async ({ query, limit, threshold }) => {
  const qEmb = await getEmbedding(query);
  const { data } = await supabase.rpc("match_thoughts", {
    query_embedding: qEmb,
    match_threshold: threshold,
    match_count: limit,
    filter: {},
  });
  // ... format results
});
```

**What it does:** Semantic search. Embeds the query, calls a PostgreSQL function that computes cosine similarity against all stored embeddings, returns ranked results.

**Key decisions:**
- Default threshold `0.5` is permissive -- catches loose associations
- Default limit `10` keeps context window manageable
- `filter: {}` means no metadata pre-filtering (simplicity over precision)
- Results include: content, metadata, similarity score, created_at
- Similarity displayed as percentage: `(t.similarity * 100).toFixed(1)% match`

**The SQL function it calls** (from `docs/01-getting-started.md`):

```sql
create or replace function match_thoughts(
  query_embedding vector(1536),
  match_threshold float default 0.7,
  match_count int default 10,
  filter jsonb default '{}'::jsonb
) returns table (id uuid, content text, metadata jsonb, similarity float, created_at timestamptz)
language plpgsql as $$
begin
  return query
  select t.id, t.content, t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter = '{}'::jsonb or t.metadata @> filter)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;
```

**Critical detail:** `<=>` is pgvector's cosine distance operator. `1 - distance = similarity`. The HNSW index makes this fast even at scale.

**Nessie adaptation:** We add pgvector to our PostgreSQL instance, add the `thoughts` table and `match_thoughts` function via Prisma migration + raw SQL. The MCP tool registration maps directly to our existing pattern in `/src/mcp/server.ts`.

### Lines 158-228: `list_thoughts` Tool

```typescript
server.registerTool("list_thoughts", {
  inputSchema: {
    limit: z.number().optional().default(10),
    type: z.string().optional(),
    topic: z.string().optional(),
    person: z.string().optional(),
    days: z.number().optional(),
  },
}, async ({ limit, type, topic, person, days }) => {
  let q = supabase.from("thoughts").select("content, metadata, created_at")
    .order("created_at", { ascending: false }).limit(limit);

  if (type) q = q.contains("metadata", { type });
  if (topic) q = q.contains("metadata", { topics: [topic] });
  if (person) q = q.contains("metadata", { people: [person] });
  if (days) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    q = q.gte("created_at", since.toISOString());
  }
  // ...
});
```

**What it does:** Structured filtering without embeddings. Browse by type, topic, person, or time range.

**Key decisions:**
- Uses `contains` for JSONB array matching (e.g., `topics: [topic]` checks if the topic is in the array)
- Uses `ilike` pattern would be better for fuzzy matching but they chose exact array containment
- Chronological ordering (newest first)
- No embedding needed -- pure metadata query

**Nessie adaptation:** This maps to a Prisma query with `jsonb` filtering. Prisma supports `JsonFilter` for JSONB columns. This is the "structured browse" complement to semantic search.

### Lines 301-363: `capture_thought` Tool

```typescript
server.registerTool("capture_thought", {
  inputSchema: {
    content: z.string().describe("The thought to capture"),
  },
}, async ({ content }) => {
  const [embedding, metadata] = await Promise.all([
    getEmbedding(content),
    extractMetadata(content),
  ]);

  const { data: upsertResult } = await supabase.rpc("upsert_thought", {
    p_content: content,
    p_payload: { metadata: { ...metadata, source: "mcp" } },
  });

  const thoughtId = upsertResult?.id;
  await supabase.from("thoughts").update({ embedding }).eq("id", thoughtId);
});
```

**What it does:** The write path. Takes raw text, generates embedding + metadata in parallel, then upserts with dedup.

**Key decisions:**
- **Parallel execution:** `Promise.all([getEmbedding, extractMetadata])` -- embedding and metadata are independent, so they run concurrently. Cuts latency ~50%.
- **Two-step write:** First `upsert_thought` (handles dedup via fingerprint), then update with embedding. This means the fingerprint-based dedup happens BEFORE the expensive embedding is stored.
- **Source tagging:** `source: "mcp"` marks where the thought came from. Other sources: `gmail`, `slack`, `import`.

**The upsert SQL function:**

```sql
CREATE OR REPLACE FUNCTION upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')
RETURNS JSONB AS $$
DECLARE
  v_fingerprint TEXT;
  v_id UUID;
BEGIN
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))),
    'UTF8'
  )), 'hex');

  INSERT INTO thoughts (content, content_fingerprint, metadata)
  VALUES (p_content, v_fingerprint, COALESCE(p_payload->'metadata', '{}'::jsonb))
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
  SET updated_at = now(),
      metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;
```

**Critical detail:** The fingerprint is `SHA-256(lower(trim(collapse_whitespace(content))))`. On conflict, it **merges metadata** rather than replacing. This means capturing the same thought from two sources enriches rather than duplicates.

**Nessie adaptation:** This is the most important function. Our implementation should:
1. Use the same fingerprint algorithm for dedup
2. Run embedding + metadata extraction in parallel
3. Add the `source` field to track voice vs. text vs. agent-generated memories
4. Expose as both an MCP tool (external clients) and an internal API (for the orchestrator to call during conversations)

---

## 3. Extension Pattern Analysis

### Pattern: One MCP Server Per Domain

Each extension (household, CRM, maintenance, calendar, meals, job hunt) is a standalone MCP server with:
- Its own `schema.sql` (tables, indexes, RLS, triggers)
- Its own `index.ts` (Hono app + MCP server + tool definitions)
- Its own Supabase Edge Function deployment
- Shared auth via the same `MCP_ACCESS_KEY`

**Template structure** (every extension):
```typescript
const app = new Hono();
app.post("*", async (c) => {
  // 1. Patch Accept header for Claude Desktop compatibility
  // 2. Validate MCP_ACCESS_KEY
  // 3. Create Supabase client
  // 4. Validate DEFAULT_USER_ID
  // 5. Create McpServer instance
  // 6. Register tools
  // 7. Connect transport, handle request
});
app.get("*", (c) => c.json({ status: "ok" }));  // health check
Deno.serve(app.fetch);
```

**Repeated boilerplate:** Lines 17-49 are identical across every extension (Accept header fix, auth check, Supabase client creation, user ID validation). This is ~30 lines of copy-paste per extension.

**Nessie adaptation:** We don't need this pattern. Our MCP server is monolithic (`/src/mcp/server.ts`), and we should keep it that way. Memory tools get registered alongside existing tools. Domain-specific memory (contacts, tasks, etc.) already lives in our Prisma schema. We add a `thoughts` table for unstructured memory and semantic search.

### Cross-Extension Bridge: `link_thought_to_contact`

```typescript
server.tool("link_thought_to_contact", {
  thought_id: z.string(),
  contact_id: z.string(),
}, async ({ thought_id, contact_id }) => {
  const { data: thought } = await supabase.from("thoughts").select("*").eq("id", thought_id).single();
  const { data: contact } = await supabase.from("professional_contacts").select("*").eq("id", contact_id).single();

  const linkNote = `\n\n[Linked Thought ${new Date().toISOString().split('T')[0]}]: ${thought.content}`;
  const updatedNotes = (contact.notes || "") + linkNote;

  await supabase.from("professional_contacts").update({ notes: updatedNotes }).eq("id", contact_id);
});
```

**What it does:** Bridges unstructured memory (thoughts) with structured data (contacts). Appends thought content to a contact's notes field.

**Critique:** This is naive -- string concatenation into a text field. No reverse lookup, no proper junction table. But it works for a v1.

**Nessie adaptation:** We'd use a proper junction table (`thought_links`) with foreign keys to both the thought and the linked entity (task, channel, agent, etc.). This creates a real knowledge graph rather than text append.

---

## 4. Schema-Aware Routing (`recipes/schema-aware-routing/index.ts`)

This is the most architecturally interesting piece. It takes unstructured text and routes it to multiple database tables based on LLM-extracted metadata.

### The Router (`processThought`)

```typescript
async function processThought(supabase, text, source = "api") {
  const [embedding, metadata] = await Promise.all([
    getEmbedding(text),
    extractMetadata(text),
  ]);

  // Route 1: ALWAYS write to thoughts
  await supabase.from("thoughts").insert({ content: text, embedding, metadata });

  // Route 2: For each person mentioned -> find/create in people table, create interaction
  for (const person of metadata.people) {
    const result = await findOrCreatePerson(supabase, person);
    if (result.id) {
      await supabase.from("interactions").insert({
        person_id: result.id, note: text, source, embedding
      });
    }
  }

  // Route 3: For each action item -> write to action_items table
  for (const actionItem of metadata.action_items) {
    await supabase.from("action_items").insert({
      title: actionItem, domain, source, status: "open"
    });
  }
}
```

**Key insight:** The raw text ALWAYS goes to `thoughts` (never lost). But structured data gets extracted and routed to appropriate domain tables simultaneously. One capture creates multiple database records.

### Person Resolution (`findOrCreatePerson`)

Three-pass system:
1. **Exact match** on name or aliases -> link to existing person
2. **Fuzzy match** on first name (includes substring check, e.g., "Rob" matches "Robert") -> flag for confirmation
3. **First-name collision** -> flag for confirmation
4. **Default** -> create new person

The fuzzy matching function:

```typescript
function namesAreSimilar(name1: string, name2: string): boolean {
  const first1 = n1.split(/\s+/)[0];
  const first2 = n2.split(/\s+/)[0];
  if (first1 === first2 && first1.length >= 3) return true;
  if (first1.length >= 3 && first2.length >= 3) {
    if (first1.includes(first2) || first2.includes(first1)) return true;
  }
  return false;
}
```

**Nessie adaptation:** This is powerful for a voice-first assistant. When the user says "tell Sarah I'll be late," the orchestrator should:
1. Capture the thought
2. Resolve "Sarah" against known contacts
3. Create an action item if the intent is a commitment
4. Link the thought to the resolved contact

This turns every voice interaction into a knowledge-building event.

---

## 5. Skills and Recipes Worth Adopting

### Live Retrieval (Proactive Memory Surfacing)

**Concept:** During active conversation, detect topic shifts and silently search memory. Surface relevant thoughts only on strong matches (>0.6 similarity). Silent on miss.

**Rules:**
- Max 3 retrievals per session (prevents noise)
- Dedup within session (don't show same thought twice)
- Never interrupt -- append to response
- 5-second timeout, skip silently on failure

**Nessie adaptation:** The orchestrator can run `search_thoughts` at the start of each conversation turn. If the user mentions a name or topic that wasn't in the previous 3 messages, search memory and inject relevant context into the system prompt. This makes Nessie feel like it "remembers."

### Auto-Capture (Session-End Persistence)

**Concept:** At session end, automatically capture:
1. Each ACT NOW item as its own thought
2. One session summary

**Rules:**
- Only capture evaluated, high-value items -- not raw conversation
- Each capture must be self-contained (understandable months later)
- Include provenance (date, source, thread)
- Skip duplicates

**Nessie adaptation:** The orchestrator diary system (`/src/db/database.ts`) already compresses conversations into summaries. We extend this: when a conversation ends, run the summary through `capture_thought` to create a searchable, semantically-indexed memory. The existing `compressDiary` function becomes the input to the memory capture pipeline.

### Panning for Gold (Transcript Processing)

**Concept:** Three-phase processing of raw brain dumps:
1. **Extract** every thread without filtering
2. **Evaluate** top threads with deep brainstorming
3. **Synthesize** into permanent gold-found file

**Nessie adaptation:** Voice transcripts from the Realtime API are prime input for this. After a long voice session, run the transcript through Panning for Gold to extract actionable items and capture them to memory. This turns rambling voice input into structured, searchable knowledge.

### Claudeception (Self-Improving Skills)

**Concept:** After each work session, evaluate whether the current work contains extractable knowledge. Create new skills from discovered patterns.

**Nessie adaptation:** When the orchestrator solves a non-obvious problem (debugging, workarounds, trial-and-error), it should capture the solution pattern as a memory. Future sessions can then retrieve that pattern when similar problems arise.

---

## 6. Data Import Pipeline (`recipes/email-history-import/pull-gmail.ts`)

### Architecture

```
Gmail API -> OAuth2 -> Fetch messages -> Filter noise -> Clean body
-> Parallel(getEmbedding, extractMetadata) -> Fingerprint -> Upsert
-> Sync log (dedup across runs)
```

### Noise Filtering (`isAutoGenerated`)

```typescript
function isAutoGenerated(msg, body): boolean {
  // Check Auto-Submitted header
  // Filter no-reply/noreply/notifications senders
  // Filter receipt/invoice/payment subjects
  // Filter password reset / verification emails
  // Detect CSS-heavy HTML (marketing emails)
  return false;
}
```

**946 lines** of production-grade email import code. Handles:
- OAuth2 with token refresh
- Gmail label filtering
- Base64url body decoding
- HTML-to-text conversion
- Quoted reply stripping
- Signature stripping
- Sync log for incremental imports
- Fingerprint dedup
- Dry-run mode
- Cost estimation

**Nessie adaptation:** This pattern generalizes to any data source. For Nessie, the equivalent imports would be:
- Calendar events (Google Calendar API)
- Notes (Apple Notes via AppleScript)
- Browser history (SQLite file)
- Slack messages (Slack API)

Each import follows the same pipeline: fetch -> filter -> clean -> embed -> extract metadata -> fingerprint -> upsert.

---

## 7. Dashboard Features

The Next.js dashboard (`dashboards/open-brain-dashboard-next/`) reveals additional memory operations not in the core MCP server:

### Types (`lib/types.ts`)

```typescript
interface Thought {
  id: number;
  content: string;
  type: string;
  source_type: string;
  importance: number;        // OB1 scores importance
  quality_score: number;     // and quality
  sensitivity_tier: string;  // with sensitivity classification
  metadata: Record<string, unknown>;
}

interface Reflection {
  thought_id: number;
  trigger_context: string;
  options: unknown[];
  factors: unknown[];
  conclusion: string;
  confidence: number;
  reflection_type: string;
}

interface IngestionJob {
  source_label: string;
  status: string;
  extracted_count: number;
  added_count: number;
  skipped_count: number;
  appended_count: number;    // appended to existing thoughts
  revised_count: number;     // revised existing thoughts
}
```

**Key additions beyond core MCP:**
- **Importance scoring** -- not all memories are equal
- **Quality scoring** -- some captures are better than others
- **Sensitivity tiers** -- some memories are private
- **Reflections** -- structured decision records linked to thoughts
- **Smart ingestion** -- bulk text auto-routed to single or multi-thought capture

### Smart Ingest (`app/api/ingest/route.ts`)

```typescript
function shouldExtract(text: string): boolean {
  if (text.length > 500) return true;
  if (paragraphs.length >= 2) return true;
  if (bulletLines.length >= 2) return true;
  if (speakerLines.length >= 2) return true;
  if (/\d{1,2}:\d{2}\s*(AM|PM)?/i.test(text)) return true;
  if (/^(From|Subject|Date|To):\s/m.test(text)) return true;
  return false;
}
```

**Heuristic routing:** Short text -> single thought. Long text, multi-paragraph, bulleted, transcript-like, or email-formatted -> extract multiple thoughts.

**Nessie adaptation:** Voice transcripts are inherently multi-topic. Every voice session should route through the extract path to pull out individual thoughts.

### Duplicate Detection (`app/api/duplicates/route.ts`)

Endpoint that finds thought pairs with similarity above a threshold (default 0.85). Returns both contents for human review.

### Thought Connections (`app/api/thoughts/[id]/connections/route.ts`)

Given a thought ID, finds semantically connected thoughts. This is the knowledge graph -- "show me everything related to this."

### Reflections (`app/api/thoughts/[id]/reflection/route.ts`)

Structured decision records: "I was deciding X, considered options A/B/C, weighted factors P/Q/R, concluded with Y at Z% confidence."

**Nessie adaptation:** When the orchestrator makes a decision (chooses between sub-agents, picks a tool, resolves an ambiguity), it should record a reflection linked to the relevant memory. This creates an auditable decision trail.

---

## 8. Implementation Plan for Nessie

### Phase 1: Core Memory Table + Embeddings

**Add to Prisma schema:**
```prisma
model Thought {
  id                 String   @id @default(uuid())
  content            String
  embedding          Unsupported("vector(1536)")?
  metadata           Json     @default("{}")
  contentFingerprint String?  @unique @map("content_fingerprint")
  source             String   @default("orchestrator")
  importance         Float    @default(0.5)
  createdAt          DateTime @default(now()) @map("created_at")
  updatedAt          DateTime @updatedAt @map("updated_at")

  @@map("thoughts")
  @@index([createdAt(sort: Desc)])
}
```

**Raw SQL migration for pgvector:**
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE INDEX ON thoughts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON thoughts USING gin (metadata);
```

**New package: `packages/memory`**
- `embed.ts` -- `getEmbedding(text: string): Promise<number[]>`
- `extract.ts` -- `extractMetadata(text: string): Promise<ThoughtMetadata>`
- `capture.ts` -- `captureThought(content: string, source: string): Promise<Thought>`
- `search.ts` -- `searchThoughts(query: string, opts?): Promise<ThoughtResult[]>`
- `fingerprint.ts` -- `contentFingerprint(text: string): Promise<string>`

### Phase 2: MCP Tools + Orchestrator Integration

**Add to `/src/mcp/server.ts`:**
- `capture_thought` -- same as OB1
- `search_thoughts` -- semantic search
- `list_thoughts` -- structured browse
- `thought_stats` -- analytics

**Orchestrator integration:**
- On conversation start: search memory for context relevant to the first user message
- On conversation end: run diary compression -> capture as thought
- On voice transcript: route through smart ingest

### Phase 3: Knowledge Graph

**Add junction table:**
```prisma
model ThoughtLink {
  id         String   @id @default(uuid())
  thoughtId  String   @map("thought_id")
  entityType String   @map("entity_type")  // "task", "channel", "agent", "contact"
  entityId   String   @map("entity_id")
  linkType   String   @map("link_type")    // "mentions", "created_by", "related_to"
  createdAt  DateTime @default(now()) @map("created_at")

  thought    Thought  @relation(fields: [thoughtId], references: [id])

  @@map("thought_links")
  @@index([entityType, entityId])
}
```

**Schema-aware routing:** When a thought mentions a person, task, or project that exists in our database, automatically create links.

### Phase 4: Proactive Memory

- **Live retrieval** in the orchestrator's conversation loop
- **Auto-capture** at conversation end
- **Importance decay** -- reduce importance of old memories that are never retrieved
- **Reflection recording** -- capture orchestrator decisions

---

## 9. What to Take, What to Skip

### Take

| Concept | Why |
|---------|-----|
| `thoughts` table with pgvector | Core value proposition -- semantic search over unstructured memory |
| Parallel embedding + metadata extraction | 50% latency reduction on writes |
| SHA-256 content fingerprint dedup | Prevents duplicate memories without expensive vector comparison |
| Metadata upsert on conflict (merge, don't replace) | Multi-source enrichment |
| `match_thoughts` SQL function | Battle-tested cosine similarity search |
| Live retrieval pattern | Makes the assistant feel like it remembers |
| Auto-capture at session end | Closes the memory flywheel |
| Smart ingest heuristic | Routes voice transcripts correctly |
| Source tagging on every capture | Audit trail for where memories come from |

### Skip

| Concept | Why |
|---------|-----|
| Separate MCP servers per domain | We have a monolithic MCP server, keep it |
| Supabase Edge Functions | We run our own API server |
| OpenRouter gateway | We already have OpenAI keys |
| Extension `schema.sql` per domain | Our Prisma schema handles this |
| `DEFAULT_USER_ID` env var | We have real auth |
| Copy-paste boilerplate across extensions | Our tool registration is already DRY |
| Dashboard (Next.js/Svelte) | We have our own admin panel |
| Gmail/email import recipes | Not relevant to voice-first assistant (yet) |
| Household/CRM/Calendar extensions | Too domain-specific; our memory is general-purpose |

### Adapt

| Concept | Adaptation |
|---------|------------|
| Cross-extension bridges | Use a proper `thought_links` junction table instead of text concatenation |
| Person resolution (fuzzy matching) | Integrate with our existing contact/user system |
| Panning for Gold | Apply to voice transcript processing |
| Claudeception | Orchestrator self-improvement through memory capture |
| Reflections | Record orchestrator decisions for audit trail |
| Importance/quality scoring | Add to our thought model, use for retrieval ranking |
