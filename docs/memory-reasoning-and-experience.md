# Memory as Experience: Capturing Reasoning Behind Intent

How to make Nessie's memory system store not just *what* was decided, but *why* — and how that reasoning accumulates into experience that improves agent judgment over time.

Draws from Remember Ninja's assertion-with-provenance model and OB1's metadata extraction, adapted to Nessie's multi-tenant, multi-agent architecture.

---

## 1. The Problem: Memory Without Reason Is a Lookup Table

### What OB1 Does

OB1 stores thoughts as flat text blobs. Each thought has:
- `content` — the raw text
- `metadata` — LLM-extracted JSON: `{ people, topics, type, action_items, dates }`
- `embedding` — 1536-dim vector for semantic search

What's missing: *why* something was stored, *what alternatives were considered*, *whether the decision worked out*. OB1's `metadata` describes the shape of the content but not the reasoning behind it. A thought like "use Auth0 for SSO" stores the decision but not that the team evaluated three providers and chose Auth0 after Okta's pricing increase.

The metadata extraction prompt (`gpt-4o-mini` in `server/index.ts:37-68`) extracts surface features, not reasoning:

```typescript
// OB1's prompt
"Extract: people (names mentioned), topics (key subjects),
 type (note/task/idea/observation/reflection), action_items, dates"
```

No field for "why," "alternatives considered," "confidence level," or "outcome."

### What Remember Ninja Does

Remember Ninja's assertion model adds three fields that OB1 lacks:

| Field | Purpose | Example |
|---|---|---|
| `provenance` | Who said it, when, from what source, in what context | `{ source: "security-review", actor_id: "user-123", context: "Post-incident review of auth breach" }` |
| `context` (in CLI) | The reasoning behind the decision | `"Evaluated Auth0, Clerk, and Okta. Chose Auth0 for SSO support and team familiarity. Okta ruled out on cost."` |
| `superseded_by` / `status` | What replaced this and why | Old assertion → `superseded`, new assertion captures the reason for change |

From Remember Ninja's website copy (`docs/website-content.md:31`):

> Most memory solutions store *what* was decided. They don't store *why*. Without the reasoning behind a decision, memory becomes a flat lookup table — not experience. Your agent knows "we use Auth0" but not "we evaluated three providers and chose Auth0 for SSO support after the Okta pricing spike." That second layer is what turns memory into judgment.

The key insight: **the `context` / `provenance` fields are the secondary memory**. They don't store the decision — they store the reasoning process that produced the decision. When the agent retrieves a fact, it also retrieves the logic trail, allowing it to evaluate whether the original reasoning still holds.

### Where Remember Ninja Falls Short for Nessie

Remember Ninja's implementation has limitations:

1. **Provenance is unstructured JSONB.** No schema enforcement on what goes in. The field might contain `{ source: "chat" }` or a paragraph of reasoning — no way to distinguish surface provenance from deep reasoning.

2. **No multi-level reasoning.** A decision may have multiple layers: the immediate reasoning ("Auth0 has SSO"), the constraints that drove evaluation ("we need SSO for enterprise clients"), and the higher-order pattern ("we optimize for time-to-market over cost"). Remember Ninja doesn't model this hierarchy.

3. **No outcome tracking.** Remember Ninja records that a decision was superseded and why, but doesn't systematically track whether the original decision was *successful* before it was changed. Did Auth0 work well for 6 months before price hikes, or was it problematic from day one?

4. **Single-user mental model.** Provenance is designed for one developer's decision history. In Nessie's multi-agent, multi-user world, reasoning may span multiple actors (user proposes, agent evaluates, another agent validates, user confirms).

---

## 2. Nessie's Reasoning Model

### Design Principles

1. **Separate what from why.** The thought content stores the fact. A linked reasoning record stores the logic.
2. **Structured reasoning, not free text.** Reasoning has a schema: alternatives, criteria, constraints, confidence, outcome.
3. **Reasoning is first-class, not metadata.** It's its own entity with its own lifecycle, not a JSONB blob hanging off a thought.
4. **Multi-actor reasoning chains.** In Nessie, a decision might involve user input + agent analysis + another agent's validation. The reasoning chain captures all contributions.
5. **Outcomes close the loop.** When a decision is later validated or invalidated, the outcome feeds back into the reasoning record. This is how experience accumulates.

### Schema: `ThoughtReasoning`

Extends the `Thought` model from `memory-security-and-scoping.md`:

```prisma
model ThoughtReasoning {
  id            String   @id @default(uuid())
  thoughtId     String
  thought       Thought  @relation(fields: [thoughtId], references: [id])

  // What kind of reasoning is this?
  reasoningType ReasoningType

  // The reasoning content
  alternatives  Json?    // What other options were considered
  criteria      Json?    // What criteria drove the decision
  constraints   Json?    // What constraints applied
  tradeoffs     Json?    // What was gained vs. sacrificed
  confidence    Float?   // 0.0 - 1.0, how confident was the decision-maker
  reasoning     String   // Free-text explanation of the logic

  // Who contributed this reasoning?
  actorType     ActorType // user, agent, service
  actorId       String

  // Outcome tracking
  outcome       OutcomeStatus @default(PENDING)
  outcomeNotes  String?
  outcomeAt     DateTime?

  // Tenant scoping (inherited from thought, but explicit for queries)
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id])

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

enum ReasoningType {
  DECISION      // Why this option was chosen over alternatives
  EVALUATION    // Assessment of options without a final decision
  CONSTRAINT    // External constraint that shapes the decision space
  PATTERN       // Higher-order observation about what tends to work
  CORRECTION    // Why a previous decision was wrong
  VALIDATION    // Confirmation that a previous decision was correct
}

enum OutcomeStatus {
  PENDING       // Not yet evaluated
  SUCCESSFUL    // Decision worked as intended
  PARTIALLY     // Worked but with caveats
  FAILED        // Decision was wrong or had bad consequences
  SUPERSEDED    // Replaced by a new decision before outcome was known
}
```

### How It Works in Practice

**Step 1: Capture a decision with reasoning**

User says: "Let's use Fastify instead of Express for the API."

Nessie stores:
- **Thought**: `"API framework: Fastify"` (the fact)
- **ThoughtReasoning**: `{ reasoningType: DECISION, alternatives: ["Express", "Hono", "Koa"], criteria: ["performance", "schema validation", "ecosystem"], reasoning: "Fastify benchmarks 2x Express for JSON serialization. Built-in schema validation eliminates ajv boilerplate. Plugin architecture cleaner than Express middleware chains.", confidence: 0.85, actorType: "user", actorId: "user-123" }`

**Step 2: Agent adds evaluation**

The orchestrator agent researches and adds its own reasoning:

- **ThoughtReasoning** (second record, same thought): `{ reasoningType: EVALUATION, criteria: ["dependency count", "community size", "TypeScript support"], reasoning: "Fastify has 0 deps in core vs Express 30. Fastify's TypeScript plugin system is type-safe by default. Express community is 10x larger but declining in new projects. Recommendation: agree with user choice.", confidence: 0.9, actorType: "agent", actorId: "orchestrator" }`

**Step 3: Outcome tracking (later)**

6 months later, the API is stable and fast. The outcome is recorded:

- Update reasoning records: `{ outcome: SUCCESSFUL, outcomeNotes: "p99 latency 12ms, zero framework-related incidents in 6 months", outcomeAt: "2026-10-08" }`

**Step 4: Experience retrieval**

When a future conversation asks "what framework should we use for the new microservice?", Nessie retrieves:
1. The original decision thought
2. All reasoning records (user's + agent's)
3. The outcome (SUCCESSFUL)
4. The agent can now say: "We chose Fastify for the main API and it worked well — p99 at 12ms, no issues in 6 months. The same criteria (performance, type safety) apply here."

That's experience, not just memory.

---

## 3. Reasoning Extraction Pipeline

### When to Extract Reasoning

Not every thought needs reasoning. A note like "meeting at 3pm" doesn't have decision logic. The extraction pipeline runs selectively:

```
Thought captured
  → Classify thought type via existing metadata extraction
  → Is it a decision, preference, architectural choice, trade-off, or constraint?
    → YES: Run reasoning extraction
    → NO: Store thought as-is (no reasoning record)
```

### Extraction Prompt

Separate from OB1-style metadata extraction. This prompt specifically targets reasoning structure:

```
Given this thought/decision: "{content}"

Extract the reasoning structure. Return JSON:
{
  "has_reasoning": true/false,
  "reasoning_type": "decision" | "evaluation" | "constraint" | "pattern" | "correction" | "validation",
  "alternatives": ["option A", "option B", ...] or null,
  "criteria": ["criterion 1", "criterion 2", ...] or null,
  "constraints": ["constraint 1", ...] or null,
  "tradeoffs": "what was gained vs. sacrificed" or null,
  "confidence": 0.0-1.0,
  "reasoning_summary": "one paragraph explaining the logic"
}

If the content is a simple note, observation, or information without decision logic, return { "has_reasoning": false }.
```

### Cost Model

Reasoning extraction uses the same `gpt-4o-mini` pipeline as metadata extraction. Running both in parallel:

```
Thought capture
  ├── getEmbedding(content)           ← ~50ms, ~$0.00001
  ├── extractMetadata(content)        ← ~200ms, ~$0.0001
  └── extractReasoning(content)       ← ~200ms, ~$0.0001
```

Total per-thought cost: ~$0.0003. At 1000 thoughts/day: ~$0.30/day.

The reasoning extraction only fires for thoughts classified as decisions/preferences/constraints, so real volume is lower.

---

## 4. Supersession Chains: How Decisions Evolve

### OB1's Approach

OB1 uses SHA-256 content fingerprinting for dedup. If the same content arrives twice, metadata is merged. But there's no concept of one thought *replacing* another. Old thoughts just sit in the database alongside new ones. The search ranking (cosine similarity) may return outdated decisions alongside current ones with no indication of which is current.

### Remember Ninja's Approach

Remember Ninja solves this with explicit status lifecycle:

```
active → superseded (by a new assertion at the same keypath)
active → retracted (marked invalid without replacement)
```

The keypath acts as a canonical address (`decisions.auth.provider`). Only one assertion can be `active` at a given keypath at a time. The full chain is preserved and queryable via the `history` and `conflicts` endpoints.

### Nessie's Adaptation

Nessie's thoughts don't have keypaths (they're more free-form than Remember Ninja's structured assertions). Instead, we use **thought links** to model supersession:

```prisma
model ThoughtLink {
  id         String   @id @default(uuid())
  sourceId   String
  targetId   String
  source     Thought  @relation("ThoughtLinksFrom", fields: [sourceId], references: [id])
  target     Thought  @relation("ThoughtLinksTo", fields: [targetId], references: [id])
  relation   ThoughtLinkRelation
  metadata   Json?
  createdAt  DateTime @default(now())
}

enum ThoughtLinkRelation {
  SUPERSEDES        // This thought replaces the target
  DERIVED_FROM      // This thought is based on the target
  CONTRADICTS       // This thought conflicts with the target
  SUPPORTS          // This thought reinforces the target
  RELATES_TO        // General association
}
```

When a decision changes:
1. New thought is created with updated content
2. A `SUPERSEDES` link connects new → old
3. Old thought's reasoning records get `outcome: SUPERSEDED`
4. New thought gets its own reasoning record explaining *why it changed*

**Query for current state:**

```sql
-- Find the "latest" decision on a topic
-- by traversing supersession chains
SELECT t.*
FROM thoughts t
WHERE t.organization_id = $1
  AND t.content_embedding <=> $query_embedding < 0.3
  AND NOT EXISTS (
    SELECT 1 FROM thought_links tl
    WHERE tl.target_id = t.id
      AND tl.relation = 'SUPERSEDES'
  )
ORDER BY t.created_at DESC
LIMIT 5;
```

This finds thoughts that haven't been superseded — the "leaf" nodes of the supersession graph.

---

## 5. Experience Accumulation Patterns

### Pattern 1: Decision Quality Scoring

Over time, reasoning records accumulate outcomes. An agent can compute decision quality:

```
Quality = count(SUCCESSFUL) / count(SUCCESSFUL + PARTIALLY + FAILED)
```

High-quality decision-makers (users or agents) have their reasoning weighted more heavily in future retrievals. An agent learns not just "what was decided" but "whose reasoning tends to be right."

### Pattern 2: Pattern Recognition

When multiple decisions share similar reasoning structures (same criteria, same constraints), the system can extract higher-order patterns:

```
Observation: In 8/10 decisions about database technology, "team familiarity"
was the top criterion and outcomes were SUCCESSFUL.
Pattern: This team/org optimizes for team familiarity over theoretical
superiority, and this strategy works.
```

These patterns become `ReasoningType.PATTERN` records — meta-reasoning that informs future decisions.

### Pattern 3: Confidence Calibration

If an agent consistently records `confidence: 0.9` but 40% of those decisions fail, the system can detect miscalibration. Future reasoning displays can show: "Agent was 90% confident, but historically its 90% confidence decisions succeed 60% of the time."

### Pattern 4: Constraint Evolution

Constraints change. "Budget is $5k/month" might become "budget increased to $20k/month." When a `CONSTRAINT` reasoning record is superseded, all decisions that cited that constraint are flagged for review: "These 3 decisions were made under the old budget constraint. They may warrant reconsideration."

---

## 6. Multi-Actor Reasoning Chains

### The Problem

In OB1 (single-user), all reasoning comes from one person. In Nessie, a decision might flow through:

1. User proposes an approach
2. Orchestrator evaluates feasibility
3. Sub-agent researches alternatives
4. Orchestrator synthesizes
5. User approves or modifies

Each step adds reasoning. The final decision's quality depends on the whole chain.

### The Model

Multiple `ThoughtReasoning` records per thought, each with its own `actorType` and `actorId`. The chain is ordered by `createdAt`:

```
ThoughtReasoning[0]: User proposes     (actorType: USER, reasoningType: DECISION)
ThoughtReasoning[1]: Agent evaluates   (actorType: AGENT, reasoningType: EVALUATION)
ThoughtReasoning[2]: Agent researches  (actorType: AGENT, reasoningType: EVALUATION)
ThoughtReasoning[3]: User confirms     (actorType: USER, reasoningType: VALIDATION)
```

When retrieving experience, the system presents the full chain so the reader understands who contributed what.

### Scoping

Reasoning records inherit the thought's visibility scope (from `memory-security-and-scoping.md`):

- **Private thoughts** → reasoning visible only to the owning user/agent
- **Channel thoughts** → reasoning visible to channel members
- **Team thoughts** → reasoning visible to team members
- **Project thoughts** → reasoning visible to project members
- **Org thoughts** → reasoning visible to org members

A user's private reasoning about a team-visible decision is stored in a separate thought linked via `SUPPORTS` or `RELATES_TO`, scoped to `private`.

---

## 7. Implementation Priority

### Phase 1: Reasoning Records (Minimal Viable Experience)

Add the `ThoughtReasoning` model and extraction pipeline alongside the thought capture system from `ob1-memory-concepts-for-nessie.md`. This gives us:
- Structured reasoning attached to decisions
- Multi-actor reasoning chains
- Basic retrieval of "why" alongside "what"

### Phase 2: Thought Links + Supersession

Add `ThoughtLink` for supersession tracking. This gives us:
- Decision evolution history
- "What's current?" queries
- Contradiction detection

### Phase 3: Outcome Tracking

Add outcome recording (manual and automated). This gives us:
- Decision quality metrics
- Confidence calibration
- Experience that actually improves over time

### Phase 4: Pattern Extraction

Automated pattern recognition over accumulated reasoning. This gives us:
- Higher-order insights ("this team optimizes for X")
- Constraint-change propagation
- Decision templates based on proven patterns

---

## 8. Comparison Table

| Capability | OB1 | Remember Ninja | Nessie (Proposed) |
|---|---|---|---|
| **What (the fact)** | `content` field | `value` field | `Thought.content` |
| **Why (reasoning)** | Not captured | `provenance` + `context` (JSONB, unstructured) | `ThoughtReasoning` (structured, typed, multi-actor) |
| **Who decided** | Implicit (single user) | `provenance.actor_id` | `ThoughtReasoning.actorType` + `actorId` |
| **Alternatives considered** | Not captured | Free text in `context` | `ThoughtReasoning.alternatives` (structured JSON) |
| **Decision criteria** | Not captured | Free text in `context` | `ThoughtReasoning.criteria` (structured JSON) |
| **Confidence level** | Not captured | Not captured | `ThoughtReasoning.confidence` (0.0-1.0) |
| **Outcome tracking** | Not captured | Not captured (supersession only) | `ThoughtReasoning.outcome` (SUCCESSFUL/FAILED/etc.) |
| **Supersession** | None (dedup only) | `active → superseded` with keypath addressing | `ThoughtLink.SUPERSEDES` (graph-based) |
| **Multi-actor reasoning** | N/A (single user) | Single `provenance.actor_id` | Multiple reasoning records per thought |
| **Pattern recognition** | Not captured | Not captured | `ReasoningType.PATTERN` (phase 4) |
| **Scoping** | Single user | `scope_type` + `scope_id` (user/team) | Inherits thought visibility (private → org) |

---

## 9. Key Takeaways

1. **Remember Ninja's core insight is correct**: memory without reasoning is just a lookup table. The `context` field that captures "why" is the most important concept to adopt.

2. **Remember Ninja's implementation is too loose**: JSONB provenance with no schema means the reasoning quality varies wildly. Nessie should enforce structure (alternatives, criteria, confidence) to make reasoning machine-queryable.

3. **OB1 misses it entirely**: OB1's metadata extraction gets *topics* and *entities*, but never asks "why was this thought worth storing?" or "what reasoning produced this decision?" This is a fundamental gap.

4. **Outcome tracking is the differentiator**: Neither OB1 nor Remember Ninja close the loop. Recording whether a decision actually worked turns memory into experience — the agent learns from past outcomes, not just past facts.

5. **Multi-actor reasoning is unique to Nessie**: Neither system models collaborative decision-making. Nessie's multi-agent architecture naturally produces multi-step reasoning chains that should be captured and made queryable.
