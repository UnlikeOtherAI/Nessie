<!-- markdownlint-disable MD009 MD013 MD029 MD031 MD032 MD040 MD060 -->
# Memory Security and Multi-Tenant Scoping

How OB1 handles memory security (and where it falls short), mapped to Nessie's multi-level tenancy model: user, channel, team, project, and organization.

---

## 1. How OB1 Does Security

### The Short Version

OB1's security model is **single-user with bolt-on household sharing**. It was designed for one person's brain, not a team. The entire system has three security layers:

1. **MCP access key** -- a shared secret in a query param or header
2. **Supabase Row Level Security (RLS)** -- `user_id` column on every table
3. **Restricted content passphrase** -- a second lock for sensitive memories

### Layer 1: MCP Access Key

Every request to the MCP server is authenticated with a single static key:

```typescript
// server/index.ts:380-385
const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
if (!provided || provided !== MCP_ACCESS_KEY) {
  return c.json({ error: "Invalid or missing access key" }, 401, corsHeaders);
}
```

**Problems:**
- One key for everything. No per-user, per-client, or per-scope keys.
- Key travels in URL query params (`?key=abc123`) -- logged in server access logs, browser history, proxy logs.
- No key rotation mechanism. Changing the key breaks all connected clients simultaneously.
- No rate limiting. Anyone with the key has unlimited access.

**What this means:** The MCP key is a gate, not an identity. It proves you're allowed to talk to the server, but says nothing about who you are or what you can see.

### Layer 2: Row Level Security (RLS)

Every table has a `user_id` column and an RLS policy:

```sql
-- Pattern used across ALL 7 schema.sql files:
ALTER TABLE thoughts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
  ON thoughts
  FOR ALL
  USING (auth.role() = 'service_role');
```

Extension tables add user-scoped policies:

```sql
-- extensions/household-knowledge/schema.sql:47-50
CREATE POLICY household_items_user_policy ON household_items
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
```

**The catch:** The MCP server uses `SUPABASE_SERVICE_ROLE_KEY`, which **bypasses all RLS**. User scoping is enforced at the application level:

```typescript
// Every extension does this:
const userId = Deno.env.get("DEFAULT_USER_ID");
// Then every query includes:
.eq("user_id", userId)
```

**Problems:**
- `DEFAULT_USER_ID` is a single env var. Every request is the same user.
- RLS exists but is irrelevant because the service role key bypasses it.
- No actual multi-user support. The architecture pretends to be multi-tenant (user_id on every row) but the server has no concept of "who is asking."
- If someone gets the service role key, they see everything for all users.

### Layer 3: Restricted Content

The dashboard adds a secondary lock for sensitive memories:

```typescript
// dashboards/open-brain-dashboard-next/lib/auth.ts:8
export interface SessionData {
  apiKey?: string;
  loggedIn?: boolean;
  restrictedUnlocked?: boolean;  // <-- second gate
}
```

Unlocking requires a passphrase verified via SHA-256:

```typescript
// app/api/restricted/route.ts:6-12
const RESTRICTED_PASSPHRASE_HASH = process.env.RESTRICTED_PASSPHRASE_HASH ?? "";

async function hashPassphrase(passphrase: string): Promise<string> {
  const encoded = new TextEncoder().encode(passphrase);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

When locked, all queries pass `exclude_restricted=true`:

```typescript
// app/api/search/route.ts:18-20
const session = await getSession();
const excludeRestricted = session.restrictedUnlocked !== true;
const data = await searchThoughts(apiKey, q, mode, 100, page, excludeRestricted);
```

**This is the only privacy mechanism in OB1.** It's a UI-level filter, not a database-level constraint. The API server presumably filters by `sensitivity_tier`, but the MCP server has no concept of restricted content at all.

### Layer 4: Household Sharing (Meal Planning Only)

One extension demonstrates shared access with reduced privileges:

```typescript
// extensions/meal-planning/shared-server.ts:28-31
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_HOUSEHOLD_KEY")!,  // SEPARATE KEY with limited permissions
);
```

The Meal Planning schema uses JWT role claims for RLS:

```sql
-- extensions/meal-planning/schema.sql:66-71
CREATE POLICY "Household members can view recipes"
    ON recipes
    FOR SELECT
    USING (
        auth.jwt() ->> 'role' = 'household_member'
        OR auth.uid() = user_id
    );
```

Household members can:
- `view_meal_plan` (SELECT only)
- `view_recipes` (SELECT only)
- `view_shopping_list` (SELECT only)
- `mark_item_purchased` (UPDATE one JSONB field only)

Cannot: create, delete, or modify recipes or plans.

**This is the closest OB1 gets to role-based access**, and it only exists in one extension.

### OB1 Audit & Cleanup

The dashboard exposes two maintenance operations:

**Audit** -- surfaces low-quality thoughts (quality_score < 30):
```typescript
// app/api/audit/route.ts:25-30
const data = await fetchThoughts(apiKey, {
  quality_score_max: 29,
  sort: "quality_score",
  order: "asc",
  exclude_restricted: excludeRestricted,
});
```

**Delete** -- batch deletion by ID array:
```typescript
// app/api/audit/delete/route.ts:17-23
const { ids } = (await request.json()) as { ids: number[] };
const results = await Promise.allSettled(
  ids.map((id) => deleteThought(apiKey, id))
);
```

No soft delete. No audit trail. No "who deleted this."

---

## 2. What Nessie Already Has

Nessie's existing schema is **properly multi-tenant**. The hierarchy:

```
Organization
  └── Project
        └── Team
              └── Channel (public | protected | private)
                    └── Thread
                          └── Message
```

### Identity Model

```typescript
// packages/schemas/src/index.ts:536-548
export const AccessActorSchema = z.object({
  actorType: z.enum(['user', 'agent', 'service']),
  actorId: NonEmptyStringSchema,
  roles: z.array(NonEmptyStringSchema).optional(),
})

export const TenantContextSchema = z.object({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
})
```

Every action carries both **who** (actor) and **where** (tenant context). This is the foundation for scoped memory.

### Session Claims

```typescript
// api/src/auth/session.ts:4-15
export type SessionTokenClaims = {
  exp: number
  iat: number
  org: string     // organization
  proj: string    // project
  sub: string     // user ID
  team: string    // team
  roles: string[]
  sid: string     // session ID
  providerId: string
  providerType: AuthProviderResponseType
}
```

The JWT carries org, project, team, and roles. Every authenticated request knows exactly which tenant scope it belongs to.

### Channel Visibility

```prisma
enum ChannelVisibility {
  public      // visible to all org members
  protected   // visible but join-restricted
  private     // visible only to members
}
```

Channels already enforce membership-based access:

```typescript
// api/src/services/channels.ts:52-58
const channels = await prisma.channel.findMany({
  where: {
    organizationId,
    members: {
      some: { userId },
    },
  },
})
```

### Membership Tables

```
OrganizationMember (organizationId, userId, role)
ProjectMember      (projectId, userId, role)
TeamMember         (teamId, userId, role)
ChannelMember      (channelId, userId)
```

Every level has explicit membership. This is what OB1 lacks entirely.

---

## 3. Audience-Bound Memory for Nessie

### The Core Idea

Memory must belong to a concrete audience object, not to a global agent
identity.

There are three different concepts that must stay separate:

1. **Agent config** -- prompt, tools, markdown docs, routing/model
2. **Installation scope** -- where an agent is available (`user`,
   `channel`, `team`, `project`)
3. **Memory audience** -- the exact object a memory was learned within
   and is allowed to be recalled into

This is the model that should power all assistants:

- a built-in `Personal Assistant` later is just a **user-scoped**
  installation
- a documentation or developer assistant can be **channel-scoped**,
  **team-scoped**, or **project-scoped**
- the same assistant config can be installed in multiple places
- those installations do **not** share hidden memory automatically

The safety rule is simple:

- assistant configuration can be shared broadly
- memory cannot

### Canonical Audience Model

Every persisted memory must have one canonical audience:

```text
user
channel
team
project
organization
```

This should be represented explicitly, not inferred only from a loose
combination of visibility fields:

```prisma
model Thought {
  id                 String            @id @default(uuid()) @db.Uuid
  content            String
  embedding          Unsupported("vector(1536)")?
  metadata           Json              @default("{}")
  contentFingerprint String?           @unique @map("content_fingerprint")
  memoryType         ThoughtMemoryType @map("memory_type")

  // Ownership
  ownerId            String            @map("owner_id") @db.Uuid
  ownerType          ThoughtOwnerType  @default(user) @map("owner_type")

  // Canonical audience
  audienceType       ThoughtAudienceType @map("audience_type")
  audienceId         String              @map("audience_id") @db.Uuid

  // Denormalized ancestry for filtering and audits
  organizationId     String            @map("organization_id") @db.Uuid
  projectId          String?           @map("project_id") @db.Uuid
  teamId             String?           @map("team_id") @db.Uuid
  channelId          String?           @map("channel_id") @db.Uuid
  userId             String?           @map("user_id") @db.Uuid

  // Classification
  source             String            @default("orchestrator")
  sensitivityTier    SensitivityTier   @default(normal) @map("sensitivity_tier")
  importance         Float             @default(0.5)

  // Lifecycle
  createdAt          DateTime          @default(now()) @map("created_at")
  updatedAt          DateTime          @updatedAt @map("updated_at")
  deletedAt          DateTime?         @map("deleted_at")
  deletedBy          String?           @map("deleted_by") @db.Uuid

  @@map("thoughts")
  @@index([organizationId, audienceType, audienceId, createdAt(sort: Desc)])
  @@index([channelId, createdAt(sort: Desc)])
  @@index([teamId, createdAt(sort: Desc)])
  @@index([projectId, createdAt(sort: Desc)])
  @@index([userId, createdAt(sort: Desc)])
}

enum ThoughtOwnerType {
  user
  agent
  system
}

enum ThoughtAudienceType {
  user
  channel
  team
  project
  organization
}

enum ThoughtMemoryType {
  intent
  reason
  constraint
  preference
  fact
  procedure
  framing
  experience
}

enum SensitivityTier {
  normal
  sensitive
  restricted
}
```

The old `visibility` enum is still useful as a compatibility view, but
`audienceType + audienceId` should be the canonical gating primitive.

During migration:

- `visibility = 'private'` maps to `audienceType = 'user'`
- `visibility` should be derived from the canonical audience on read,
  not maintained as a second source of truth
- if `visibility` and `audienceType` disagree on write, the write must be
  rejected
- `audienceId` must be validated against a real audience object on every
  write, with ancestry columns checked for consistency

`ownerId` and `ownerType` still matter, but for a different purpose:

- `owner*` answers "who created or owns this memory record?"
- `audience*` answers "who may safely learn from this memory?"

They may align, but they are not the same concept. Examples:

- A user's private note: owner = user, audience = same user
- An agent-created project summary: owner = agent, audience = project
- A system-generated org runbook: owner = system, audience = organization

### Installation Scope vs. Memory Audience

These are related but not interchangeable.

Examples:

- A DM run with the built-in assistant writes user-scoped memory by
  default.
- A user-scoped assistant writes user-scoped memory by default.
- A channel-scoped developer assistant writes channel-scoped memory by
  default.
- A project assistant writes project-scoped memory by default.
- A project assistant answering inside a specific channel still cannot
  surface memories whose original audience is incompatible with the
  current reply audience.

The same assistant config can exist in many scopes, but each run still
has its own output audience. "Same agent" must not mean "same memory
everywhere."

---

## 4. Access Model: Retrieval Requires Two Checks

### Check 1: Can the requester access the source audience?

This is the basic membership question:

- user audience -> requester must be that user
- channel audience -> requester must be a channel member
- team audience -> requester must be a team member
- project audience -> requester must be a project member
- organization audience -> requester must be an org member

### Check 2: Can the memory be surfaced into the current output audience?

This is the crucial team-safety check.

It is **not enough** that the requesting user personally has access to a
memory. The assistant is about to answer into some surface that other
people may also be able to see. The system must ensure that the reply's
audience is compatible with the memory's source audience.

Compatibility rule:

```text
Audience(output) ⊆ Audience(source)
```

Meaning:

- the set of people who can see the answer must be equal to or smaller
  than the set of people who were allowed to know the memory originally
- surfacing a memory into a broader audience is a leak and must be
  blocked
- surfacing a memory into the same audience is fine
- surfacing a memory into a stricter subset audience is fine
- declassification does not override this check for the raw source
  memory; it creates a new broader-scope artifact or promoted memory that
  can then be recalled under normal rules

Examples:

- A memory from a 5-person `#core-team` channel may be recalled into a
  2-person private thread between members of `#core-team`.
- A memory from a private project may not be recalled into a public
  channel, even if the requesting user belongs to both.
- A channel-scoped memory may not be used to answer in a project-wide
  assistant unless it was explicitly promoted.
- A user's private memory may not be surfaced into a shared channel just
  because that same user is present there. Moving from one viewer to many
  viewers is a scope widening event and must be promoted explicitly.

### Retrieval Pseudocode

```typescript
type AudienceRef = {
  type: 'user' | 'channel' | 'team' | 'project' | 'organization'
  id: string
}

function canRecallThoughtToAudience(
  thought: ThoughtRecord,
  requester: AccessActor,
  outputAudience: AudienceRef,
): boolean {
  if (!requesterCanAccessAudience(requester, thought.audienceType, thought.audienceId)) {
    return false
  }

  if (thought.sensitivityTier === 'restricted' && !requesterHasRestrictedUnlock(requester)) {
    return false
  }

  return audienceMembers(outputAudience).isSubsetOf(
    audienceMembers({
      type: thought.audienceType,
      id: thought.audienceId,
    }),
  )
}
```

### Follow-Up Denial Behavior

If a user asks a follow-up that would require an incompatible memory, the
assistant must not hint or partially reveal the hidden content. It should
respond with a scoped denial such as:

> I don't have access to that project information from this conversation
> context.

Or, if the issue is the viewer set rather than the requesting user:

> I can't discuss that here because this channel doesn't have access to
> that information.

The denial should name the scope boundary, not the secret itself.

### Retrieval SQL Shape

The current `match_thoughts_scoped` signature is not enough because it
only knows `organizationId` and `userId`. The target contract must also
take the current output audience:

```sql
CREATE OR REPLACE FUNCTION match_thoughts_scoped(
  p_query_embedding vector(1536),
  p_org_id UUID,
  p_user_id UUID,
  p_output_audience_type TEXT,
  p_output_audience_id UUID,
  p_match_threshold FLOAT DEFAULT 0.5,
  p_match_count INT DEFAULT 10,
  p_include_sensitivity TEXT[] DEFAULT ARRAY['normal']
) RETURNS TABLE (...)
```

That function must enforce:

- org hard wall
- requester membership for the source audience
- sensitivity checks
- audience compatibility between the source memory and output audience

Because `audienceType` is polymorphic, Prisma cannot express this as one
simple foreign key. Validation must therefore happen in the service layer
on every write and in query helpers on every read.

---

## 5. Capture-Time Rules

### Default Write Rule

New memory inherits the current run's output audience by default.

That means:

- DM run -> user-scoped memory
- channel run -> channel-scoped memory
- team run -> team-scoped memory
- project run -> project-scoped memory
- agent-captured memory -> the current run's output audience, not the
  agent's global identity

This rule is much safer than "agent-owned memory by default" because it
prevents an assistant from accumulating a hidden global brain just by
being reused across contexts.

### Capture Context

```typescript
interface CaptureContext {
  actor: {
    actorType: 'user' | 'agent' | 'service'
    actorId: string
  }
  tenant: {
    organizationId: string
    projectId?: string
    teamId?: string
    channelId?: string
  }
  outputAudience: {
    type: 'user' | 'channel' | 'team' | 'project' | 'organization'
    id: string
  }
  source: 'voice' | 'text' | 'orchestrator' | 'agent' | 'mcp' | 'import'
}
```

`actor` and `source` answer different questions:

- `actor` = who is responsible for the action
- `source` = what ingestion path produced the memory

Examples:

- user speaking in a voice session -> `actorType = 'user'`,
  `source = 'voice'`
- agent writing a summary -> `actorType = 'agent'`,
  `source = 'orchestrator'`
- imported memory from an external connector -> `actorType = 'service'`,
  `source = 'import'`

### Default Audience Resolution

```typescript
function resolveAudience(ctx: CaptureContext): AudienceRef {
  return ctx.outputAudience
}
```

The important part is that the assistant does not get to choose a wider
default. Widening scope is a separate, explicit action.

Any persisted summary, reflection, or run-derived note must carry the
same canonical audience fields as ordinary memories. If those artifacts
live outside the `thoughts` table, they still need equivalent
`outputAudience` tagging and compatibility enforcement.

### Sensitivity Tiers

Three tiers, enforced at retrieval and declassification time:

| Tier | When | Access |
|------|------|--------|
| `normal` | Default | Standard audience rules |
| `sensitive` | PII, salary, health, personal | Excluded from default search unless `include_sensitive=true`, then still subject to audience rules |
| `restricted` | Secrets, credentials, legal, repo-sensitive material | Never returned by normal retrieval; requires explicit session unlock and dedicated restricted-path retrieval |

The metadata extraction prompt should classify sensitivity:

```text
Extract metadata from the captured thought. Return JSON with:
- "sensitivity": one of "normal", "sensitive", "restricted"
  - "sensitive" for personal or confidential people data
  - "restricted" for secrets, credentials, legal matters, or
    confidential technical/business material
  - "normal" otherwise
```

---

## 6. Promotion, Declassification, and Shared Knowledge

### Default Rule

Memories do not widen automatically.

That includes:

- semantic memories
- procedural memories
- summaries
- reflections
- agent-generated markdown notes
- agent system-prompt updates

If something learned in a narrow audience should become reusable
elsewhere, it must go through an explicit promotion or declassification
step.

### Promotion Examples

- Channel procedure -> promoted to project procedure after review
- Project decision -> promoted to org runbook after approval
- User-private preference -> stays private, never promoted automatically

The manager's intent to share knowledge is real, but it must be explicit
and auditable. "Useful" is not enough to widen scope.

### Declassification Events

```text
declassification_events
  id                UUID PK
  source_audience   JSONB
  target_audience   JSONB
  actor_id          UUID
  authority         TEXT
  source_memory_ids UUID[]
  derived_artifact_id UUID
  justification     TEXT
  approved_at       TIMESTAMPTZ
  created_at        TIMESTAMPTZ
```

Rules:

- Procedural memory -> org-wide skill promotion is declassification.
- Memory-informed system prompt updates are declassification only when
  they widen scope beyond the source audience.
- Memory-informed summaries shared to a wider audience are
  declassification.
- A promoted markdown document is a declassification event if it
  incorporates narrow-scope memories.
- Org-scoped memories captured directly in an org-scoped run are not
  declassification. Only widening from a narrower source audience counts.

---

## 7. Assistants and Secret Leakage

### What "Experience" Should Mean

Experience is useful only inside compatible audiences. It should not be
treated as a global agent brain.

Safe examples:

- A user's built-in assistant remembers that user's private preferences
  in their DM.
- A channel developer assistant remembers the repo conventions of that
  channel.
- A project assistant remembers project-wide architecture decisions that
  are intentionally project-visible.

Unsafe example:

- A developer assistant works in a private repo channel, then later
  answers in a broader engineering channel and leaks project secrets
  because the same agent config "remembers" too much.

That is exactly what the audience model is meant to stop.

### Cross-Channel Follow-Up Rule

There is no magic cross-channel bridge.

If an assistant working in `#channel-b` needs knowledge originally learned
in `#channel-a`, one of the following must already be true:

- the memory was promoted to a broader compatible audience
- a reviewed artifact derived from it was promoted
- the current run is happening inside a narrower audience compatible with
  the original source

Otherwise the assistant should not "know that it knows" the hidden
context. The safe behavior is denial, not clever inference.

### Same Config, Different Audiences

Nessie should support this model:

- one assistant definition
- many installations at different scopes
- separate run audiences
- separate memory audiences

So:

- the assistant runtime can be the same everywhere
- the hidden memory cannot

### Personal Assistant Later

After this audience model exists, a built-in `Personal Assistant` becomes
simple:

- mandatory user-scoped installation
- pinned at the top of DMs
- shared admin-controlled config
- private user-scoped memory

The personal assistant feature should be built on top of this model, not
before it. It is a follow-on consumer of this design, not the subject of
this brief.

### Personalization

Personalization remains per-user, but it should live in a separate user
parameter store rather than the audience-scoped `thoughts` table. It is
shared across that user's assistants because it describes the user, not a
channel or project.

---

## 8. Deletion and Audit Trail

Unlike OB1's hard delete, Nessie should soft-delete with audit:

```prisma
model Thought {
  // ...existing fields...
  deletedAt          DateTime?         @map("deleted_at")
  deletedBy          String?           @map("deleted_by") @db.Uuid
}
```

```prisma
model ThoughtAuditLog {
  id          String   @id @default(uuid()) @db.Uuid
  thoughtId   String   @map("thought_id") @db.Uuid
  action      String   // 'created' | 'updated' | 'deleted' | 'promoted' | 'demoted' | 'sensitivity_changed'
  actorId     String   @map("actor_id") @db.Uuid
  actorType   String   @map("actor_type") // 'user' | 'agent' | 'system'
  oldValue    Json?    @map("old_value")
  newValue    Json?    @map("new_value")
  createdAt   DateTime @default(now()) @map("created_at")

  @@map("thought_audit_log")
  @@index([thoughtId, createdAt(sort: Desc)])
  @@index([actorId, createdAt(sort: Desc)])
}
```

Every mutation to a thought (create, update, delete, audience change,
declassification, sensitivity change) gets logged with who did it and
what changed. Soft-deleted thoughts are excluded from search but
recoverable.

---

## 9. OB1 vs Nessie Security Comparison

| Aspect | OB1 | Nessie (proposed) |
|--------|-----|-------------------|
| Identity | `DEFAULT_USER_ID` env var | JWT with user, org, project, team, roles |
| Auth | Static shared key | HMAC-signed session token with expiry |
| Multi-user | No (faked with user_id column) | Yes (membership tables at every level) |
| Multi-org | No | Yes (org is the hard boundary) |
| Scope levels | 1 (user) | 5 (user, channel, team, project, org) |
| RLS | Present but bypassed by service role | Application-level with SQL functions |
| Sensitivity | Dashboard-only passphrase toggle | Three tiers with LLM auto-classification |
| Deletion | Hard delete, no audit | Soft delete with full audit trail |
| Agent memories | Not supported | First-class, but audience-bound rather than globally agent-bound |
| Shared access | One extension, read-only | Explicit audience compatibility + declassification |
| Cross-scope search | No concept | Only when requester access and output-audience compatibility both pass |
| Audit trail | None | Every mutation logged with actor |

---

## 10. Implementation Priorities

### Must Have (Phase 1)

1. Canonical `audience_type` + `audience_id` on `thoughts`
2. `outputAudience` on runs and memory capture flows
3. `match_thoughts_scoped` with requester membership and output-audience compatibility
4. Hard org boundary on all queries
5. Scoped denial behavior for blocked recalls

### Should Have (Phase 2)

6. `thought_audit_log` table
7. Soft delete
8. Sensitivity auto-classification in metadata extraction prompt
9. Promotion/declassification API and audit records

### Nice to Have (Phase 3)

10. Managed assistant installations across user/channel/team/project scope
11. Restricted content session unlock for exceptional cases
12. Quality scoring with audit-based cleanup
13. Cross-project sharing only through explicit promotion
