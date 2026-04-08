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

## 3. Memory Scoping Design for Nessie

### The Core Idea

Every thought has a **scope** that determines who can see it. The scope is a combination of:

1. **Owner** -- who created it (always set)
2. **Visibility** -- who else can see it
3. **Tenant boundary** -- the org/project/team/channel it belongs to

### Thought Schema

```prisma
model Thought {
  id                 String            @id @default(uuid()) @db.Uuid
  content            String
  embedding          Unsupported("vector(1536)")?
  metadata           Json              @default("{}")
  contentFingerprint String?           @unique @map("content_fingerprint")

  // Ownership
  ownerId            String            @map("owner_id") @db.Uuid
  ownerType          ThoughtOwnerType  @default(user) @map("owner_type")

  // Scoping
  visibility         ThoughtVisibility @default(private)
  organizationId     String            @map("organization_id") @db.Uuid
  projectId          String?           @map("project_id") @db.Uuid
  teamId             String?           @map("team_id") @db.Uuid
  channelId          String?           @map("channel_id") @db.Uuid

  // Classification
  source             String            @default("orchestrator")
  sensitivityTier    SensitivityTier   @default(normal) @map("sensitivity_tier")
  importance         Float             @default(0.5)

  // Lifecycle
  createdAt          DateTime          @default(now()) @map("created_at")
  updatedAt          DateTime          @updatedAt @map("updated_at")

  // Relations
  owner              User              @relation(fields: [ownerId], references: [id])
  organization       Organization      @relation(fields: [organizationId], references: [id])

  @@map("thoughts")
  @@index([ownerId, createdAt(sort: Desc)])
  @@index([organizationId, visibility, createdAt(sort: Desc)])
  @@index([channelId, createdAt(sort: Desc)])
  @@index([createdAt(sort: Desc)])
}

enum ThoughtOwnerType {
  user
  agent
  system
}

enum ThoughtVisibility {
  private           // only the owner
  channel           // members of the channel
  team              // members of the team
  project           // members of the project
  organization      // all org members
}

enum SensitivityTier {
  normal
  sensitive         // excluded from search unless explicitly unlocked
  restricted        // requires elevated permission to access
}
```

### How Visibility Works

When a thought is captured, the scope is set based on context:

| Source | Default Visibility | Default Scope |
|--------|-------------------|---------------|
| User voice note in a channel | `channel` | channel where spoken |
| User voice note, no channel | `private` | user's org |
| Agent decision during a run | `channel` | channel the run is in |
| Orchestrator diary compression | `private` | user's org |
| System-generated insight | `organization` | org-wide |
| MCP external capture | `private` | user's org |

### Query-Time Filtering

Every search/list operation applies a visibility filter. The filter resolves the caller's memberships and returns only thoughts they're allowed to see.

```sql
-- The core access check as a SQL function
CREATE OR REPLACE FUNCTION can_access_thought(
  p_thought_id UUID,
  p_user_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_thought RECORD;
BEGIN
  SELECT visibility, owner_id, organization_id, project_id, team_id, channel_id,
         sensitivity_tier
  INTO v_thought
  FROM thoughts WHERE id = p_thought_id;

  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- Owner always has access
  IF v_thought.owner_id = p_user_id THEN RETURN TRUE; END IF;

  -- Restricted content requires explicit unlock (handled at app layer)
  IF v_thought.sensitivity_tier = 'restricted' THEN RETURN FALSE; END IF;

  -- Visibility checks
  CASE v_thought.visibility
    WHEN 'private' THEN
      RETURN FALSE;

    WHEN 'channel' THEN
      RETURN EXISTS (
        SELECT 1 FROM channel_members
        WHERE channel_id = v_thought.channel_id AND user_id = p_user_id
      );

    WHEN 'team' THEN
      RETURN EXISTS (
        SELECT 1 FROM team_members
        WHERE team_id = v_thought.team_id AND user_id = p_user_id
      );

    WHEN 'project' THEN
      RETURN EXISTS (
        SELECT 1 FROM project_members
        WHERE project_id = v_thought.project_id AND user_id = p_user_id
      );

    WHEN 'organization' THEN
      RETURN EXISTS (
        SELECT 1 FROM organization_members
        WHERE organization_id = v_thought.organization_id AND user_id = p_user_id
      );

    ELSE RETURN FALSE;
  END CASE;
END;
$$;
```

### Semantic Search with Scoping

The `match_thoughts` function from OB1 gets extended with access control:

```sql
CREATE OR REPLACE FUNCTION match_thoughts_scoped(
  p_query_embedding vector(1536),
  p_user_id UUID,
  p_org_id UUID,
  p_match_threshold FLOAT DEFAULT 0.5,
  p_match_count INT DEFAULT 10,
  p_include_sensitivity TEXT[] DEFAULT ARRAY['normal']
) RETURNS TABLE (
  id UUID,
  content TEXT,
  metadata JSONB,
  similarity FLOAT,
  visibility TEXT,
  owner_id UUID,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> p_query_embedding) AS similarity,
    t.visibility::TEXT,
    t.owner_id,
    t.created_at
  FROM thoughts t
  WHERE
    -- Similarity threshold
    1 - (t.embedding <=> p_query_embedding) > p_match_threshold
    -- Org boundary (hard wall)
    AND t.organization_id = p_org_id
    -- Sensitivity filter
    AND t.sensitivity_tier::TEXT = ANY(p_include_sensitivity)
    -- Visibility check
    AND (
      t.owner_id = p_user_id
      OR (t.visibility = 'organization'
          AND EXISTS (SELECT 1 FROM organization_members
                      WHERE organization_id = p_org_id AND user_id = p_user_id))
      OR (t.visibility = 'project'
          AND EXISTS (SELECT 1 FROM project_members
                      WHERE project_id = t.project_id AND user_id = p_user_id))
      OR (t.visibility = 'team'
          AND EXISTS (SELECT 1 FROM team_members
                      WHERE team_id = t.team_id AND user_id = p_user_id))
      OR (t.visibility = 'channel'
          AND EXISTS (SELECT 1 FROM channel_members
                      WHERE channel_id = t.channel_id AND user_id = p_user_id))
    )
  ORDER BY t.embedding <=> p_query_embedding
  LIMIT p_match_count;
END;
$$;
```

**Key difference from OB1:** The org boundary (`t.organization_id = p_org_id`) is a **hard wall**. There is no cross-org memory leakage. Within the org, visibility cascades from private up to organization-wide.

---

## 4. Experience Layer

"Experience" is the accumulation of memory over time. It's what makes an agent in channel A aware of relevant context from channel B (if the visibility allows it).

### How Memories Accumulate

```
Voice session in #engineering
  └── Transcript → smart ingest → 3 thoughts (visibility: channel)
  └── Diary compression → 1 summary thought (visibility: private)
  └── Decision recorded → 1 reflection thought (visibility: team)

Later, in #product:
  └── User mentions same topic
  └── Live retrieval searches scoped thoughts
  └── Finds the engineering thought (if user is in both channels)
  └── Surfaces it: "Related context from #engineering (March 14)"
```

### Experience Scope Hierarchy

```
┌──────────────────────────────────────────────────┐
│ Organization                                      │
│  ┌────────────────────────────────────────────┐   │
│  │ Project                                     │   │
│  │  ┌──────────────────────────────────────┐   │   │
│  │  │ Team                                  │   │   │
│  │  │  ┌──────────┐  ┌──────────┐          │   │   │
│  │  │  │ Channel A │  │ Channel B │          │   │   │
│  │  │  └──────────┘  └──────────┘          │   │   │
│  │  └──────────────────────────────────────┘   │   │
│  └────────────────────────────────────────────┘   │
│  ┌──────────────────┐                             │
│  │ User (private)    │                             │
│  └──────────────────┘                             │
└──────────────────────────────────────────────────┘
```

When searching for context, the query resolves all scopes the user has access to, ordered by relevance (similarity), not scope. A highly relevant org-wide thought ranks above a weakly relevant channel thought.

### Agent-Owned Memories

Agents capture memories too. An agent bound to a channel accumulates experience about that channel's topics:

```
Agent "CodeReview" bound to #engineering:
  - Remembers: "Team prefers explicit error types over generic Error"
  - Remembers: "PR #42 introduced the new auth middleware pattern"
  - Remembers: "Sarah is the database schema owner"

Agent "ProductAssistant" bound to #product:
  - Remembers: "Q3 roadmap prioritizes mobile experience"
  - Remembers: "Competitor X launched feature Y on March 10"
```

Agent memories are scoped to their bound channel by default, but can be promoted:

```typescript
enum ThoughtOwnerType {
  user    // human-created
  agent   // agent-created, scoped to binding
  system  // system-generated, org-wide
}
```

### Sensitivity Tiers

Three tiers, enforced at the application layer:

| Tier | When | Access |
|------|------|--------|
| `normal` | Default | Standard visibility rules |
| `sensitive` | PII, salary, health, personal | Excluded from search results unless `include_sensitive=true` is passed |
| `restricted` | Secrets, credentials, legal | Requires explicit unlock per session (like OB1's passphrase) |

The metadata extraction prompt should classify sensitivity:

```
Extract metadata from the user's captured thought. Return JSON with:
...existing fields...
- "sensitivity": one of "normal", "sensitive", "restricted"
  - "sensitive" if it contains: personal health info, salary/compensation,
    performance reviews, personal relationships, private opinions about colleagues
  - "restricted" if it contains: passwords, API keys, legal matters,
    confidential business strategy
  - "normal" for everything else
```

---

## 5. Capture-Time Scoping Rules

When `capture_thought` is called, the scope is derived from context:

```typescript
interface CaptureContext {
  // Who
  actor: {
    actorType: 'user' | 'agent' | 'service'
    actorId: string
  }

  // Where (from session claims)
  tenant: {
    organizationId: string
    projectId?: string
    teamId?: string
    channelId?: string
  }

  // How
  source: 'voice' | 'text' | 'orchestrator' | 'agent' | 'mcp' | 'import'

  // Override (optional -- caller can set explicitly)
  visibility?: ThoughtVisibility
}
```

Default visibility resolution:

```typescript
function resolveVisibility(ctx: CaptureContext): ThoughtVisibility {
  // Explicit override wins
  if (ctx.visibility) return ctx.visibility

  // Agent captures default to channel scope
  if (ctx.actor.actorType === 'agent') return 'channel'

  // Voice/text in a channel defaults to channel
  if (ctx.tenant.channelId) return 'channel'

  // Voice/text with no channel defaults to private
  return 'private'
}
```

### Promotion and Demotion

A thought's visibility can be changed after capture:

- **Promote:** `private` -> `team` -> `project` -> `organization` (requires appropriate membership)
- **Demote:** `organization` -> `project` -> `team` -> `channel` -> `private` (only owner or admin)
- **Sensitivity change:** Any authorized user can mark as `sensitive`; only admins can mark/unmark `restricted`

---

## 6. Deletion and Audit Trail

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

Every mutation to a thought (create, update, delete, visibility change, sensitivity change) gets logged with who did it and what changed. Soft-deleted thoughts are excluded from search but recoverable.

---

## 7. OB1 vs Nessie Security Comparison

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
| Agent memories | Not supported | First-class, scoped to agent binding |
| Shared access | One extension, read-only | Visibility enum on every thought |
| Cross-scope search | No concept | Yes, resolves all accessible scopes |
| Audit trail | None | Every mutation logged with actor |

---

## 8. Implementation Priorities

### Must Have (Phase 1)

1. `thoughts` table with `owner_id`, `organization_id`, `visibility`, `sensitivity_tier`
2. `match_thoughts_scoped` SQL function with membership checks
3. Capture-time scope resolution from session claims
4. Hard org boundary on all queries

### Should Have (Phase 2)

5. `thought_audit_log` table
6. Soft delete
7. Sensitivity auto-classification in metadata extraction prompt
8. Visibility promotion/demotion API

### Nice to Have (Phase 3)

9. Agent-owned memories scoped to channel binding
10. Restricted content passphrase unlock (OB1 pattern)
11. Quality scoring with audit-based cleanup
12. Cross-project memory sharing (opt-in per thought)
