# Phase 2 Token Ledger Implementation Review

**Status**: Implementation Readiness Assessment  
**Reviewer**: Claude (via Code Review)  
**Date**: 2026-04-08  

---

## Executive Summary

The Token Ledger feature for Phase 2 is **NOT IMPLEMENTATION-READY**. While the specification is comprehensive (token-ledger-spec.md), the codebase lacks:

1. **Zero Prisma models** for token ledger storage
2. **Zero API endpoints** for token ledger ingestion and reporting
3. **Zero worker integration** for token event emission
4. **Zero schema types** in packages/schemas
5. **Zero admin UI scaffolding** for token ledger views

The specification is sound. The integration points are clear. But nothing is wired together. This checklist breaks down exactly what must be built.

---

## 1. PRISMA GAPS: Database Models and Migrations

### Required Models

Add these models to `/System/Volumes/Data/.internal/projects/Projects/nessie/api/prisma/schema.prisma`:

```prisma
// Token ledger event - core immutable record of all usage
model TokenLedgerEvent {
  id                  String    @id @default(uuid()) @db.Uuid
  eventId             String    @unique // user-facing event identifier
  occurredAt          DateTime  // ISO timestamp when token usage occurred
  
  // Scope denormalization for efficient queries
  organizationId      String    @map("organization_id") @db.Uuid
  projectId           String?   @map("project_id") @db.Uuid
  teamId              String?   @map("team_id") @db.Uuid
  channelId           String?   @map("channel_id") @db.Uuid
  threadId            String?   @map("thread_id") @db.Uuid
  sessionId           String?   @map("session_id")
  taskId              String?   @map("task_id") @db.Uuid
  agentId             String?   @map("agent_id") @db.Uuid
  actorId             String?   @map("actor_id") @db.Uuid
  
  // Request/correlation context
  requestId           String    @map("request_id")
  correlationId       String?   @map("correlation_id")
  
  // Provider and model identity
  provider            String    // e.g. "openai", "anthropic", "minimax", "google"
  model               String    // provider-native model name
  
  // Operation type
  operationType       String    @map("operation_type") // "chat", "completion", "embedding", etc.
  
  // Token counts - all optional, null if not reported
  inputTokens         Int?      @map("input_tokens")
  outputTokens        Int?      @map("output_tokens")
  cachedInputTokens   Int?      @map("cached_input_tokens")
  cachedOutputTokens  Int?      @map("cached_output_tokens")
  cacheReadTokens     Int?      @map("cache_read_tokens")
  cacheWriteTokens    Int?      @map("cache_write_tokens")
  totalTokens         Int?      @map("total_tokens")
  
  // Provider-reported cost (when available)
  providerCostAmount  Decimal?  @map("provider_cost_amount") @db.Decimal(12, 6)
  providerCostCurrency String?  @map("provider_cost_currency") // ISO 4217
  
  // Pricing snapshot at time of event
  pricingProfileId    String?   @map("pricing_profile_id") @db.Uuid
  pricingSource       String?   @map("pricing_source") // "provider-default", "org-override", "team-override", "manual"
  pricingCurrency     String?   @map("pricing_currency")
  pricingInputPerMillion      Decimal? @map("pricing_input_per_million") @db.Decimal(12, 8)
  pricingOutputPerMillion     Decimal? @map("pricing_output_per_million") @db.Decimal(12, 8)
  pricingCachedInputPerMillion Decimal? @map("pricing_cached_input_per_million") @db.Decimal(12, 8)
  pricingCachedOutputPerMillion Decimal? @map("pricing_cached_output_per_million") @db.Decimal(12, 8)
  pricingCacheReadPerMillion  Decimal? @map("pricing_cache_read_per_million") @db.Decimal(12, 8)
  pricingCacheWritePerMillion Decimal? @map("pricing_cache_write_per_million") @db.Decimal(12, 8)
  
  // Nessie-estimated cost
  estimatedCostAmount Decimal?  @map("estimated_cost_amount") @db.Decimal(12, 6)
  estimatedCostCurrency String? @map("estimated_cost_currency")
  
  // Custom metadata
  metadata            Json      @default("{}")
  
  // Timestamps
  createdAt           DateTime  @default(now()) @map("created_at")
  
  // Foreign keys
  organization        Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  project             Project?  @relation(fields: [projectId], references: [id], onDelete: SetNull)
  team                Team?     @relation(fields: [teamId], references: [id], onDelete: SetNull)
  channel             Channel?  @relation(fields: [channelId], references: [id], onDelete: SetNull)
  thread              Thread?   @relation(fields: [threadId], references: [id], onDelete: SetNull)
  task                Task?     @relation(fields: [taskId], references: [id], onDelete: SetNull)
  agent               Agent?    @relation(fields: [agentId], references: [id], onDelete: SetNull)
  pricingProfile      ModelPricingProfile? @relation(fields: [pricingProfileId], references: [id], onDelete: SetNull)
  
  // Indexes for common query patterns
  @@index([organizationId, occurredAt])
  @@index([organizationId, provider, model])
  @@index([projectId, occurredAt])
  @@index([teamId, occurredAt])
  @@index([channelId, occurredAt])
  @@index([agentId, occurredAt])
  @@index([actorId, occurredAt])
  @@index([provider, model])
  @@index([taskId])
  @@index([createdAt])
  @@map("token_ledger_events")
}

// Pricing profiles - configuration for cost estimation
model ModelPricingProfile {
  id              String    @id @default(uuid()) @db.Uuid
  organizationId  String    @map("organization_id") @db.Uuid
  
  // Scope specification
  provider        String    // e.g. "openai", "anthropic"
  modelPattern    String    @map("model_pattern") // exact model name or wildcard
  
  // Pricing terms
  currency        String    // ISO 4217
  inputPerMillion Decimal?  @map("input_per_million") @db.Decimal(12, 8)
  outputPerMillion Decimal? @map("output_per_million") @db.Decimal(12, 8)
  cachedInputPerMillion Decimal? @map("cached_input_per_million") @db.Decimal(12, 8)
  cachedOutputPerMillion Decimal? @map("cached_output_per_million") @db.Decimal(12, 8)
  cacheReadPerMillion Decimal? @map("cache_read_per_million") @db.Decimal(12, 8)
  cacheWritePerMillion Decimal? @map("cache_write_per_million") @db.Decimal(12, 8)
  
  // Override source
  source          String    // "provider-default", "org-override", "team-override", "manual"
  
  // Audit trail
  createdBy       String    @map("created_by") // user ID
  createdAt       DateTime  @default(now()) @map("created_at")
  
  // Effective date range
  effectiveFrom   DateTime  @map("effective_from")
  effectiveTo     DateTime? @map("effective_to")
  
  // Relations
  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  events          TokenLedgerEvent[]
  
  // Indexes
  @@unique([organizationId, provider, modelPattern, effectiveFrom])
  @@index([organizationId, provider, modelPattern])
  @@index([effectiveFrom, effectiveTo])
  @@map("model_pricing_profiles")
}
```

### Schema Updates

Update existing models to link to token ledger:

**Run model**: Add optional relation
```prisma
model Run {
  // ... existing fields ...
  tokenLedgerEvents TokenLedgerEvent[]
}
```

**Organization model**: Add relations for auditing
```prisma
model Organization {
  // ... existing fields ...
  tokenLedgerEvents TokenLedgerEvent[]
  pricingProfiles    ModelPricingProfile[]
}
```

**Project model**: Add relation
```prisma
model Project {
  // ... existing fields ...
  tokenLedgerEvents TokenLedgerEvent[]
}
```

**Team model**: Add relation
```prisma
model Team {
  // ... existing fields ...
  tokenLedgerEvents TokenLedgerEvent[]
}
```

**Channel model**: Add relation
```prisma
model Channel {
  // ... existing fields ...
  tokenLedgerEvents TokenLedgerEvent[]
}
```

**Thread model**: Add relation
```prisma
model Thread {
  // ... existing fields ...
  tokenLedgerEvents TokenLedgerEvent[]
}
```

**Agent model**: Add relation
```prisma
model Agent {
  // ... existing fields ...
  tokenLedgerEvents TokenLedgerEvent[]
}
```

**Task model**: Add relation
```prisma
model Task {
  // ... existing fields ...
  tokenLedgerEvents TokenLedgerEvent[]
}
```

### Migration Strategy

1. Create migration: `npx prisma migrate dev --name add_token_ledger_v1`
2. Raw SQL migration required for:
   - `token_ledger_events` table with all columns and indexes
   - `model_pricing_profiles` table with constraints
   - Foreign key constraints
3. Seed script to insert provider-default pricing profiles for common providers (OpenAI, Anthropic, Google, Minimax)
4. Initial `effectiveFrom` = 2026-01-01 for provider defaults

---

## 2. WORKER CHANGES: Token Event Emission

### Where to Emit (executeRunJob in worker/src/run/execute.ts)

The worker must emit a token ledger event **after** the model streams successfully completes. Add emission in these locations:

**Location 1: After successful model call** (line ~619-644)

Insert after the model stream completes and before `assistantMessage` creation:

```typescript
// After model streaming completes
const tokenEvent = {
  eventId: randomUUID(),
  occurredAt: new Date().toISOString(),
  organizationId: context.channel.organizationId,
  projectId: payload.actorContext.tenant.projectId ?? undefined,
  teamId: payload.actorContext.tenant.teamId ?? undefined,
  channelId: context.channel.id,
  threadId: context.run.threadId,
  sessionId: payload.actorContext.actionContext.sessionId ?? undefined,
  taskId: context.task.id,
  agentId: context.agent.id,
  actorId: payload.actorContext.actor.actorId,
  requestId: payload.actorContext.actionContext.requestId,
  correlationId: payload.actorContext.actionContext.correlationId ?? undefined,
  provider: 'anthropic', // or resolved from config
  model: 'claude-opus-4', // or actual model used
  operationType: 'chat',
  usage: {
    inputTokens: modelClient.lastInputTokens,
    outputTokens: modelClient.lastOutputTokens,
    totalTokens: (modelClient.lastInputTokens ?? 0) + (modelClient.lastOutputTokens ?? 0),
    // Cache metrics if available from response
    cachedInputTokens: modelClient.lastCachedInputTokens ?? undefined,
    cachedOutputTokens: modelClient.lastCachedOutputTokens ?? undefined,
  },
  providerReportedCost: modelClient.lastProviderCost ?? undefined,
  // pricingSnapshot populated by emission handler
  metadata: {
    runId: context.run.id,
    toolsUsed: toolOutputs.length > 0 ? ['document_read', 'web_fetch', 'web_search'] : [],
  },
};

await emitTokenLedgerEvent(deps, tokenEvent);
```

**Location 2: For tool calls** (line ~321-339)

Each safe tool execution should emit a token ledger event:

```typescript
// Inside recordToolEnd, also emit token ledger event for tool execution
const toolTokenEvent = {
  eventId: randomUUID(),
  occurredAt: new Date().toISOString(),
  organizationId: context.channel.organizationId,
  projectId: /* from context */,
  teamId: /* from context */,
  channelId: context.channel.id,
  threadId: context.run.threadId,
  taskId: context.task.id,
  agentId: context.agent.id,
  actorId: /* from payload */,
  requestId: /* from payload */,
  correlationId: /* from payload */,
  provider: 'tool-translation', // or 'web-search', 'document-read' as separate provider
  model: input.toolName, // e.g. "web_search", "document_read"
  operationType: 'tool-translation',
  usage: {
    // Tools don't generate tokens, but could track API calls
    totalTokens: 0,
  },
  metadata: {
    runId: context.run.id,
    toolName: input.toolName,
    success: input.success,
    durationMs: input.durationMs,
  },
};

await emitTokenLedgerEvent(deps, toolTokenEvent);
```

### New Worker Functions to Implement

**File**: `worker/src/services/token-ledger.ts`

```typescript
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { TokenLedgerEvent } from '@nessie/schemas'

export const emitTokenLedgerEvent = async (
  deps: ExecutionDependencies,
  event: TokenLedgerEvent,
): Promise<void> => {
  // Best-effort insertion — log errors but do not fail the run
  try {
    // Resolve pricing profile for this provider/model combo
    const pricingProfile = await resolvePricingProfile(
      deps.prisma,
      event.organizationId,
      event.provider,
      event.model,
    )

    // Calculate estimated cost
    const estimatedCost = calculateEstimatedCost(event.usage, pricingProfile)

    // Persist the event
    await deps.prisma.tokenLedgerEvent.create({
      data: {
        eventId: event.eventId,
        occurredAt: new Date(event.occurredAt),
        organizationId: event.organizationId,
        projectId: event.projectId,
        teamId: event.teamId,
        channelId: event.channelId,
        threadId: event.threadId,
        sessionId: event.sessionId,
        taskId: event.taskId,
        agentId: event.agentId,
        actorId: event.actorId,
        requestId: event.requestId,
        correlationId: event.correlationId,
        provider: event.provider,
        model: event.model,
        operationType: event.operationType,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cachedInputTokens: event.usage.cachedInputTokens,
        cachedOutputTokens: event.usage.cachedOutputTokens,
        cacheReadTokens: event.usage.cacheReadTokens,
        cacheWriteTokens: event.usage.cacheWriteTokens,
        totalTokens: event.usage.totalTokens,
        providerCostAmount: event.providerReportedCost?.amount,
        providerCostCurrency: event.providerReportedCost?.currency,
        pricingProfileId: pricingProfile?.id,
        pricingSource: pricingProfile?.source,
        pricingCurrency: pricingProfile?.currency,
        pricingInputPerMillion: pricingProfile?.inputPerMillion,
        pricingOutputPerMillion: pricingProfile?.outputPerMillion,
        // ... other pricing fields ...
        estimatedCostAmount: estimatedCost?.amount,
        estimatedCostCurrency: estimatedCost?.currency,
        metadata: event.metadata,
      },
    })
  } catch (error) {
    // Log but do not fail the run
    console.error('Failed to emit token ledger event:', error)
    // Consider writing to a dead-letter queue for audit trail
  }
}

const resolvePricingProfile = async (
  prisma: PrismaClient,
  organizationId: string,
  provider: string,
  model: string,
): Promise<ModelPricingProfile | null> => {
  const now = new Date()

  // Lookup hierarchy:
  // 1. Exact organization + team + provider + model override (future)
  // 2. Exact organization + provider + model override
  // 3. Organization wildcard override
  // 4. Provider default

  // For Phase 2, skip team-level overrides
  const exactOverride = await prisma.modelPricingProfile.findFirst({
    where: {
      organizationId,
      provider,
      modelPattern: model,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  })

  if (exactOverride) {
    return exactOverride
  }

  const wildcardOverride = await prisma.modelPricingProfile.findFirst({
    where: {
      organizationId,
      provider,
      modelPattern: '*',
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  })

  if (wildcardOverride) {
    return wildcardOverride
  }

  // Default profile lookup (source = 'provider-default')
  const defaultProfile = await prisma.modelPricingProfile.findFirst({
    where: {
      organizationId,
      provider,
      source: 'provider-default',
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  })

  return defaultProfile ?? null
}

const calculateEstimatedCost = (
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cachedOutputTokens?: number },
  profile: ModelPricingProfile | null,
): { amount: number; currency: string } | null => {
  if (!profile) {
    return null
  }

  let cost = 0n // Use BigInt for precision
  const inputTokens = BigInt(usage.inputTokens ?? 0)
  const outputTokens = BigInt(usage.outputTokens ?? 0)
  const cachedInputTokens = BigInt(usage.cachedInputTokens ?? 0)
  const cachedOutputTokens = BigInt(usage.cachedOutputTokens ?? 0)

  if (profile.inputPerMillion && inputTokens > 0n) {
    cost += (inputTokens * BigInt(profile.inputPerMillion.toFixed(0))) / 1000000n
  }
  if (profile.outputPerMillion && outputTokens > 0n) {
    cost += (outputTokens * BigInt(profile.outputPerMillion.toFixed(0))) / 1000000n
  }
  if (profile.cachedInputPerMillion && cachedInputTokens > 0n) {
    cost += (cachedInputTokens * BigInt(profile.cachedInputPerMillion.toFixed(0))) / 1000000n
  }
  if (profile.cachedOutputPerMillion && cachedOutputTokens > 0n) {
    cost += (cachedOutputTokens * BigInt(profile.cachedOutputPerMillion.toFixed(0))) / 1000000n
  }

  return {
    amount: Number(cost) / 1000000,
    currency: profile.currency,
  }
}
```

### Integration Points in executeRunJob

Add imports at top:
```typescript
import { emitTokenLedgerEvent } from './services/token-ledger.js'
import { randomUUID } from 'node:crypto'
```

Call after successful model stream (around line 619):
```typescript
await emitTokenLedgerEvent(deps, {
  eventId: randomUUID(),
  occurredAt: new Date().toISOString(),
  // ... populate all required fields from context and payload
})
```

---

## 3. API ROUTE PLAN: Complete Endpoint Specification

### Core Token Ledger Routes

Add all endpoints to `/api/src/index.ts`:

#### POST /api/ledger/tokens/events
**Purpose**: Ingest one or more token usage events  
**Auth**: Required (organization member)  
**Request**:
```typescript
{
  events: TokenLedgerEvent[]
}
```

**Response**:
```typescript
{
  data: {
    ingested: number
    failed: number
    errors?: Array<{
      eventId: string
      code: string
      message: string
    }>
  }
}
```

**Implementation notes**:
- Best-effort: persist what is valid, return partial success
- Validate event schema, return validation errors
- Denormalize scopes (organization through task/agent)
- Audit who submitted events

#### GET /api/ledger/tokens/summary
**Purpose**: Aggregate usage and cost by scope  
**Auth**: Required  
**Query params**:
```typescript
{
  organizationId: string  // required, must match actor's org
  projectId?: string
  teamId?: string
  channelId?: string
  agentId?: string
  actorId?: string
  provider?: string
  model?: string
  from?: ISO8601    // start date
  to?: ISO8601      // end date
  groupBy?: 'day' | 'week' | 'month' | 'provider' | 'model' | 'agent' | 'user'
}
```

**Response**:
```typescript
{
  data: {
    period: {
      from: ISO8601
      to: ISO8601
    }
    summary: {
      totalInputTokens: number
      totalOutputTokens: number
      totalCachedInputTokens: number
      totalCachedOutputTokens: number
      totalEstimatedCost: number
      estimatedCurrency: string
      totalProviderReportedCost?: number
      costDelta?: number
    }
    groupedByDay?: Array<{
      date: string
      inputTokens: number
      outputTokens: number
      estimatedCost: number
    }>
    groupedByProvider?: Array<{
      provider: string
      models: Array<{
        model: string
        inputTokens: number
        outputTokens: number
        estimatedCost: number
      }>
    }>
  }
}
```

#### GET /api/ledger/tokens/events
**Purpose**: Raw event stream with pagination  
**Auth**: Required (org-scoped)  
**Query params**:
```typescript
{
  organizationId: string  // required
  cursor?: string
  limit?: number (1-200, default 50)
  direction?: 'forward' | 'backward'
  from?: ISO8601
  to?: ISO8601
  provider?: string
  model?: string
}
```

**Response**:
```typescript
{
  data: TokenLedgerEvent[]
  meta: {
    cursor: string | null
    hasMore: boolean
  }
}
```

#### GET /api/ledger/tokens/pricing
**Purpose**: List active pricing profiles for organization  
**Auth**: Required  
**Query params**:
```typescript
{
  organizationId: string  // required
  provider?: string
  model?: string
}
```

**Response**:
```typescript
{
  data: ModelPricingProfile[]
}
```

#### POST /api/ledger/tokens/pricing
**Purpose**: Create or update pricing override  
**Auth**: Required (organization owner)  
**Request**:
```typescript
{
  provider: string
  modelPattern: string
  currency: string
  inputPerMillion?: number
  outputPerMillion?: number
  cachedInputPerMillion?: number
  cachedOutputPerMillion?: number
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
  effectiveFrom?: ISO8601  // default now
  effectiveTo?: ISO8601
}
```

**Response**:
```typescript
{
  data: ModelPricingProfile
}
```

**Implementation notes**:
- Validate currency is ISO 4217
- Check organization ownership
- Create audit entry (via task event or separate audit table)
- Set `source: 'org-override'` and `createdBy: actorId`

#### DELETE /api/ledger/tokens/pricing/{profileId}
**Purpose**: Soft-delete a pricing profile (set effectiveTo to now)  
**Auth**: Required (organization owner)

**Response**:
```typescript
{
  data: { profileId: string; status: 'deleted' }
}
```

**Implementation notes**:
- Set `effectiveTo = now()` instead of hard delete (audit trail)
- Cannot delete provider-default profiles

#### GET /api/ledger/tokens/monthly-estimate
**Purpose**: Monthly estimate and forecast by scope  
**Auth**: Required  
**Query params**:
```typescript
{
  organizationId: string  // required
  month?: string  // YYYY-MM, default current month
  includeProjection?: boolean  // forecast next 30 days
}
```

**Response**:
```typescript
{
  data: {
    period: {
      year: number
      month: number
      from: ISO8601
      to: ISO8601
    }
    mtd: {
      inputTokens: number
      outputTokens: number
      estimatedCost: number
      currency: string
    }
    projection?: {
      estimatedMonthlyTotal: number
      dailyAverage: number
      confidence: 'low' | 'medium' | 'high'
    }
    byTeam?: Array<{
      teamId: string
      teamName: string
      estimatedCost: number
    }>
    byAgent?: Array<{
      agentId: string
      agentName: string
      estimatedCost: number
    }>
  }
}
```

### Permissions and Visibility

| Endpoint | Owner | Admin | TeamOwner | Member |
|----------|-------|-------|-----------|--------|
| POST /events | ✓ | ✓ | ✓ | ✓ |
| GET /summary | ✓ | ✓ | ✓* | ✓* |
| GET /events | ✓ | ✓ | ✓* | ✓* |
| GET /pricing | ✓ | ✓ | ✗ | ✗ |
| POST /pricing | ✓ | ✓ | ✗ | ✗ |
| DELETE /pricing | ✓ | ✓ | ✗ | ✗ |
| GET /monthly-estimate | ✓ | ✓ | ✓* | ✓* |

*Team owners and members can view only team-scoped data. Members cannot view cost.

---

## 4. SCHEMA ADDITIONS: Type Definitions

### Required Types in packages/schemas/src/index.ts

Add Zod schemas and TypeScript types:

```typescript
// Token usage fields
export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cachedOutputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
})
export type TokenUsage = z.infer<typeof TokenUsageSchema>

// Cost record
export const CostSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3), // ISO 4217
})
export type Cost = z.infer<typeof CostSchema>

// Pricing snapshot
export const PricingSnapshotSchema = z.object({
  profileId: NonEmptyStringSchema.optional(),
  source: z.enum(['provider-default', 'org-override', 'team-override', 'manual']).optional(),
  currency: z.string().length(3).optional(),
  inputPerMillion: z.number().nonnegative().optional(),
  outputPerMillion: z.number().nonnegative().optional(),
  cachedInputPerMillion: z.number().nonnegative().optional(),
  cachedOutputPerMillion: z.number().nonnegative().optional(),
  cacheReadPerMillion: z.number().nonnegative().optional(),
  cacheWritePerMillion: z.number().nonnegative().optional(),
})
export type PricingSnapshot = z.infer<typeof PricingSnapshotSchema>

// Main token ledger event
export const TokenLedgerEventSchema = z.object({
  eventId: NonEmptyStringSchema,
  occurredAt: TimestampSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  threadId: ThreadIdSchema.optional(),
  sessionId: NonEmptyStringSchema.optional(),
  taskId: TaskIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  actorId: NonEmptyStringSchema.optional(),
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  operationType: z.enum([
    'chat',
    'completion',
    'embedding',
    'translation',
    'reasoning',
    'tool-translation',
    'other',
  ]),
  usage: TokenUsageSchema,
  providerReportedCost: CostSchema.optional(),
  pricingSnapshot: PricingSnapshotSchema.optional(),
  estimatedCost: CostSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type TokenLedgerEvent = z.infer<typeof TokenLedgerEventSchema>

// Pricing profile
export const ModelPricingProfileSchema = z.object({
  profileId: NonEmptyStringSchema,
  organizationId: OrganizationIdSchema,
  provider: NonEmptyStringSchema,
  modelPattern: NonEmptyStringSchema,
  currency: z.string().length(3),
  source: z.enum(['provider-default', 'org-override', 'team-override', 'manual']),
  inputPerMillion: z.number().nonnegative().optional(),
  outputPerMillion: z.number().nonnegative().optional(),
  cachedInputPerMillion: z.number().nonnegative().optional(),
  cachedOutputPerMillion: z.number().nonnegative().optional(),
  cacheReadPerMillion: z.number().nonnegative().optional(),
  cacheWritePerMillion: z.number().nonnegative().optional(),
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema.optional(),
  createdBy: NonEmptyStringSchema,
})
export type ModelPricingProfile = z.infer<typeof ModelPricingProfileSchema>

// API request/response schemas
export const IngestTokenEventsRequestSchema = z.object({
  events: TokenLedgerEventSchema.array().min(1),
})

export const IngestTokenEventsResponseSchema = z.object({
  ingested: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errors: z.array(z.object({
    eventId: NonEmptyStringSchema,
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
  })).optional(),
})

export const TokenLedgerSummarySchema = z.object({
  period: z.object({
    from: TimestampSchema,
    to: TimestampSchema,
  }),
  summary: z.object({
    totalInputTokens: z.number().int().nonnegative(),
    totalOutputTokens: z.number().int().nonnegative(),
    totalCachedInputTokens: z.number().int().nonnegative(),
    totalCachedOutputTokens: z.number().int().nonnegative(),
    totalEstimatedCost: z.number().nonnegative(),
    estimatedCurrency: z.string().length(3),
    totalProviderReportedCost: z.number().nonnegative().optional(),
    costDelta: z.number().optional(),
  }),
})
export type TokenLedgerSummary = z.infer<typeof TokenLedgerSummarySchema>
```

---

## 5. FACADE PLAN: Admin Frontend Hooks and Queries

### New Admin Facades in admin/src/facades/

Create file: `admin/src/facades/tokenLedger.ts`

```typescript
import { useQuery, useMutation } from '@tanstack/react-query'
import type { TokenLedgerEvent, ModelPricingProfile } from '@nessie/schemas'

interface TokenLedgerFilters {
  from?: Date
  to?: Date
  provider?: string
  model?: string
  groupBy?: 'day' | 'week' | 'month' | 'provider' | 'model' | 'agent' | 'user'
}

// Query: Token ledger summary
export const useTokenLedgerSummary = (
  organizationId: string,
  filters: TokenLedgerFilters,
) => {
  return useQuery({
    queryKey: ['tokenLedger', 'summary', organizationId, filters],
    queryFn: async () => {
      const params = new URLSearchParams({
        organizationId,
        ...(filters.from && { from: filters.from.toISOString() }),
        ...(filters.to && { to: filters.to.toISOString() }),
        ...(filters.provider && { provider: filters.provider }),
        ...(filters.model && { model: filters.model }),
        ...(filters.groupBy && { groupBy: filters.groupBy }),
      })

      const response = await fetch(`/api/ledger/tokens/summary?${params}`)
      if (!response.ok) throw new Error('Failed to fetch token ledger summary')
      return response.json()
    },
  })
}

// Query: Raw events list
export const useTokenLedgerEvents = (
  organizationId: string,
  options?: {
    cursor?: string
    limit?: number
    from?: Date
    to?: Date
    provider?: string
    model?: string
  },
) => {
  return useQuery({
    queryKey: ['tokenLedger', 'events', organizationId, options],
    queryFn: async () => {
      const params = new URLSearchParams({
        organizationId,
        limit: String(options?.limit ?? 50),
        ...(options?.cursor && { cursor: options.cursor }),
        ...(options?.from && { from: options.from.toISOString() }),
        ...(options?.to && { to: options.to.toISOString() }),
        ...(options?.provider && { provider: options.provider }),
        ...(options?.model && { model: options.model }),
      })

      const response = await fetch(`/api/ledger/tokens/events?${params}`)
      if (!response.ok) throw new Error('Failed to fetch token ledger events')
      return response.json()
    },
  })
}

// Query: Monthly estimate
export const useTokenLedgerMonthlyEstimate = (
  organizationId: string,
  month?: string,
  includeProjection = true,
) => {
  return useQuery({
    queryKey: ['tokenLedger', 'monthlyEstimate', organizationId, month, includeProjection],
    queryFn: async () => {
      const params = new URLSearchParams({
        organizationId,
        includeProjection: String(includeProjection),
        ...(month && { month }),
      })

      const response = await fetch(`/api/ledger/tokens/monthly-estimate?${params}`)
      if (!response.ok) throw new Error('Failed to fetch monthly estimate')
      return response.json()
    },
  })
}

// Query: Pricing profiles
export const useTokenLedgerPricingProfiles = (organizationId: string) => {
  return useQuery({
    queryKey: ['tokenLedger', 'pricing', organizationId],
    queryFn: async () => {
      const response = await fetch(
        `/api/ledger/tokens/pricing?organizationId=${organizationId}`,
      )
      if (!response.ok) throw new Error('Failed to fetch pricing profiles')
      return response.json()
    },
  })
}

// Mutation: Create/update pricing profile
export const useCreatePricingProfile = () => {
  return useMutation({
    mutationFn: async (profile: Partial<ModelPricingProfile>) => {
      const response = await fetch('/api/ledger/tokens/pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      })
      if (!response.ok) throw new Error('Failed to create pricing profile')
      return response.json()
    },
  })
}

// Mutation: Delete pricing profile
export const useDeletePricingProfile = () => {
  return useMutation({
    mutationFn: async (profileId: string) => {
      const response = await fetch(`/api/ledger/tokens/pricing/${profileId}`, {
        method: 'DELETE',
      })
      if (!response.ok) throw new Error('Failed to delete pricing profile')
      return response.json()
    },
  })
}
```

### Required Admin UI Pages

#### admin/src/pages/TokenLedgerPage.tsx
Components needed:
- Token summary card (total cost this month, daily average)
- Filter panel (date range, provider, model, grouping)
- Cost trend chart (Recharts line chart by day/week/month)
- Cost breakdown (pie chart: by provider, by agent, by operation type)
- Raw events table (paginated, sortable)

#### admin/src/pages/PricingProfilesPage.tsx
Components needed:
- Active pricing profiles table
- Create/edit profile form
- Effective date timeline visualization
- Provider/model pattern selector
- Delete with confirmation
- Audit trail (who changed what when)

### Context/Provider for Token Ledger State

File: `admin/src/providers/TokenLedgerProvider.tsx`

```typescript
import React, { createContext, useContext } from 'react'

interface TokenLedgerContextType {
  selectedOrganizationId: string
  dateRange: { from: Date; to: Date }
  setDateRange: (range: { from: Date; to: Date }) => void
  filterProvider?: string
  setFilterProvider: (provider?: string) => void
}

const TokenLedgerContext = createContext<TokenLedgerContextType | undefined>(undefined)

export const useTokenLedgerContext = () => {
  const context = useContext(TokenLedgerContext)
  if (!context) {
    throw new Error('useTokenLedgerContext must be used within TokenLedgerProvider')
  }
  return context
}

export const TokenLedgerProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [dateRange, setDateRange] = React.useState({
    from: new Date(new Date().setDate(new Date().getDate() - 30)),
    to: new Date(),
  })
  const [filterProvider, setFilterProvider] = React.useState<string | undefined>()

  return (
    <TokenLedgerContext.Provider
      value={{
        selectedOrganizationId: '...', // from auth context
        dateRange,
        setDateRange,
        filterProvider,
        setFilterProvider,
      }}
    >
      {children}
    </TokenLedgerContext.Provider>
  )
}
```

---

## 6. EDGE CASES: Failure Modes and Handling

### Case 1: Model Provider Does Not Report Usage

**Scenario**: LLM provider returns no `usage` field in response  
**Spec says**: "if a provider does not expose a metric, the field remains null rather than guessed"

**Implementation**:
```typescript
// In worker token-ledger service
const usage = {
  inputTokens: response.usage?.input_tokens ?? undefined,
  outputTokens: response.usage?.output_tokens ?? undefined,
  totalTokens: response.usage?.total_tokens ?? undefined,
  // Do NOT estimate: leave undefined
}

// Estimate cost skipped if tokens are undefined
if (!usage.inputTokens && !usage.outputTokens) {
  estimatedCost = null
}
```

**Database**:
- Store NULLs for missing token counts
- Cost estimation skipped (estimatedCostAmount and estimatedCostCurrency remain NULL)
- Report visible in admin UI shows "provider did not report usage"

### Case 2: Pricing Profile Does Not Exist

**Scenario**: Token event for provider/model with no pricing profile  
**Spec requirement**: "canonical ledger preserves both provider-reported cost... and Nessie-estimated cost using the active pricing profile"

**Implementation**:
```typescript
const pricingProfile = await resolvePricingProfile(
  prisma,
  event.organizationId,
  event.provider,
  event.model,
)

if (!pricingProfile) {
  // No fallback estimation; cost remains unmeasured
  estimatedCost = null
  pricingProfileId = null
  // Log warning for ops team
  console.warn(
    `No pricing profile for ${event.provider}/${event.model} in org ${event.organizationId}`,
  )
}
```

**UI handling**:
- Summary queries show `null` for estimated cost when no profile
- Admin can see in pricing page which models lack profiles
- Notification: "Cost estimates unavailable for 3 model/provider combinations"

### Case 3: Worker Crashes Before Token Event Emission

**Scenario**: Run completes successfully, but crash occurs before `emitTokenLedgerEvent()` call

**Implementation**:
```typescript
// Structure: emit AFTER model completes, BEFORE run status update
try {
  // ... model stream ...
  const responseText = await collectStream()

  // Emit ledger event FIRST
  await emitTokenLedgerEvent(deps, {
    // ... usage data from model stream ...
  })

  // THEN persist message and update status
  const message = await deps.prisma.message.create({...})
  await updateRunStatus(...)
} catch (error) {
  // If ledger event failed to emit (logged but not thrown),
  // we still need to update run status for visibility
}
```

**Durability**:
- Token ledger emission is best-effort but logged
- Failed emissions written to separate `TokenLedgerEmissionDeadLetter` table (future)
- Retry mechanism for backfilled events via admin API
- Run completion not blocked by ledger emission failure

### Case 4: Organization Deletes Pricing Profile Mid-Month

**Scenario**: Active override profile is soft-deleted (effectiveTo set to now)

**Implementation**:
```typescript
// resolvePricingProfile checks effectiveTo
const profile = await prisma.modelPricingProfile.findFirst({
  where: {
    organizationId,
    provider,
    modelPattern,
    effectiveFrom: { lte: now },
    OR: [
      { effectiveTo: null },           // No end date
      { effectiveTo: { gt: now } }     // Future end date
    ],
  },
})

// Events already recorded with old profile keep that snapshot
// Future events get next-best profile (wildcard or default)
```

**Monthly estimate impact**:
- Summary shows cost calculated with active profile at event time
- If profile changes mid-month, estimate uses mixed pricing
- Audited in pricing profile change log

### Case 5: Concurrent Token Submissions (Race Condition)

**Scenario**: Multiple workers emit events for same run simultaneously

**Implementation**:
```typescript
// Prisma handles concurrent inserts naturally
// eventId is UNIQUE constraint prevents duplicates
await prisma.tokenLedgerEvent.create({
  data: {
    eventId: randomUUID(), // Guarantees uniqueness
    // ... other fields ...
  },
})

// If duplicate eventId:
// Prisma throws unique constraint error
// emitTokenLedgerEvent catches, logs, returns gracefully
```

### Case 6: Expired Session Token in Ledger Event

**Scenario**: Token event captured with sessionId that is now expired/deleted

**Implementation**:
```typescript
// Store sessionId as string (not foreign key)
const event = {
  sessionId: payload.actorContext.actionContext.sessionId,
  // No constraint - value stored for audit trail even if session deleted
}

// Query filters respect eventual consistency
// Events stay queryable by organization/agent/date even if session purged
```

---

## 7. TESTING STRATEGY

### Unit Tests

**File**: `api/tests/ledger.test.ts`

```typescript
describe('Token Ledger', () => {
  describe('resolvePricingProfile', () => {
    it('should return exact override when available', async () => {
      // Setup: create org, provider, exact model profile
      // Assert: resolvePricingProfile returns exact match
    })

    it('should fall back to wildcard override', async () => {
      // Setup: create org, provider, wildcard profile but no exact
      // Assert: returns wildcard profile
    })

    it('should fall back to default profile', async () => {
      // Setup: no overrides, only provider default
      // Assert: returns provider default
    })

    it('should return null when no profile exists', async () => {
      // Setup: new provider/model combination
      // Assert: returns null
    })

    it('should respect effectiveFrom and effectiveTo dates', async () => {
      // Setup: profile with past effectiveFrom and future effectiveTo
      // Assert: profile returned for current time
      // Set time to past: profile not returned
      // Set time to future: profile not returned
    })
  })

  describe('calculateEstimatedCost', () => {
    it('should calculate cost from input and output tokens', () => {
      const usage = { inputTokens: 1000, outputTokens: 500 }
      const profile = {
        inputPerMillion: 0.5,
        outputPerMillion: 1.5,
        currency: 'USD',
      }
      const cost = calculateEstimatedCost(usage, profile)
      expect(cost.amount).toBe((1000 * 0.5 + 500 * 1.5) / 1000000)
    })

    it('should include cached token costs', () => {
      const usage = {
        inputTokens: 1000,
        cachedInputTokens: 500,
      }
      const profile = {
        inputPerMillion: 1.0,
        cachedInputPerMillion: 0.1,
        currency: 'USD',
      }
      const cost = calculateEstimatedCost(usage, profile)
      expect(cost.amount).toBe((1000 * 1.0 + 500 * 0.1) / 1000000)
    })

    it('should return null if no profile', () => {
      const cost = calculateEstimatedCost({}, null)
      expect(cost).toBeNull()
    })
  })
})
```

### Integration Tests

**File**: `api/tests/token-ledger-api.test.ts`

```typescript
describe('Token Ledger API', () => {
  describe('POST /api/ledger/tokens/events', () => {
    it('should ingest a valid token event', async () => {
      const response = await client.post('/api/ledger/tokens/events', {
        events: [
          {
            eventId: 'test-event-1',
            occurredAt: new Date().toISOString(),
            organizationId: testOrgId,
            provider: 'openai',
            model: 'gpt-4',
            operationType: 'chat',
            usage: { inputTokens: 100, outputTokens: 50 },
            requestId: 'req-123',
          },
        ],
      })

      expect(response.status).toBe(200)
      expect(response.data.data.ingested).toBe(1)
    })

    it('should return partial success for mixed valid/invalid events', async () => {
      // ... submit 3 events, 2 valid 1 invalid
      // Assert: ingested: 2, failed: 1, errors array populated
    })
  })

  describe('GET /api/ledger/tokens/summary', () => {
    it('should aggregate usage across events', async () => {
      // Setup: create 5 events with varied tokens
      // Query: /summary?organizationId=X&from=2026-04-01&to=2026-04-30
      // Assert: totalInputTokens = sum, totalOutputTokens = sum
    })

    it('should support groupBy provider', async () => {
      // Setup: events from openai and anthropic
      // Query: /summary?organizationId=X&groupBy=provider
      // Assert: response.groupedByProvider has 2 entries
    })

    it('should calculate estimated cost from pricing profile', async () => {
      // Setup: create profile with inputPerMillion: 0.5
      // Create event with 1M input tokens
      // Assert: estimatedCost.amount = 0.5
    })

    it('should respect permission boundaries', async () => {
      // Setup: member of org A queries summary for org B
      // Assert: 403 Forbidden
    })
  })

  describe('GET /api/ledger/tokens/events', () => {
    it('should return paginated events', async () => {
      // Setup: create 100 events
      // Query: /events?organizationId=X&limit=10
      // Assert: returns 10 events, hasMore: true, cursor present
    })

    it('should support cursor-based pagination', async () => {
      // Fetch page 1, get cursor
      // Fetch page 2 using cursor
      // Assert: different events returned
    })
  })

  describe('POST /api/ledger/tokens/pricing', () => {
    it('should create pricing profile for organization', async () => {
      const response = await client.post(
        '/api/ledger/tokens/pricing',
        {
          provider: 'openai',
          modelPattern: 'gpt-4-*',
          currency: 'USD',
          inputPerMillion: 0.03,
          outputPerMillion: 0.06,
        },
      )

      expect(response.status).toBe(201)
      expect(response.data.data.profileId).toBeDefined()
    })

    it('should enforce owner-only access', async () => {
      // Try as member: expect 403
    })
  })

  describe('GET /api/ledger/tokens/monthly-estimate', () => {
    it('should return MTD estimate', async () => {
      // Setup: events this month
      // Query: /monthly-estimate?organizationId=X
      // Assert: mtd section populated
    })

    it('should include projection when requested', async () => {
      // Query with includeProjection: true
      // Assert: projection section with estimatedMonthlyTotal
    })

    it('should break down by team and agent', async () => {
      // Setup: events from multiple agents
      // Assert: byAgent array populated
    })
  })
})
```

### Worker Integration Tests

**File**: `worker/tests/token-ledger-emission.test.ts`

```typescript
describe('Token Ledger Emission in Worker', () => {
  it('should emit event after successful model call', async () => {
    const run = await setupTestRun()
    await executeRunJob(deps, payload)

    const event = await prisma.tokenLedgerEvent.findUnique({
      where: { eventId: expect.any(String) },
    })

    expect(event).toBeDefined()
    expect(event.provider).toBe('anthropic')
    expect(event.inputTokens).toBeGreaterThan(0)
    expect(event.organizationId).toBe(run.thread.channel.organizationId)
  })

  it('should resolve pricing profile and calculate cost', async () => {
    // Setup: create pricing profile for org
    await executeRunJob(deps, payload)

    const event = await prisma.tokenLedgerEvent.findFirst()
    expect(event.pricingProfileId).toBeDefined()
    expect(event.estimatedCostAmount).toBeGreaterThan(0)
  })

  it('should handle missing pricing profile gracefully', async () => {
    // Setup: no pricing profile for this provider/model
    await executeRunJob(deps, payload)

    const event = await prisma.tokenLedgerEvent.findFirst()
    expect(event.pricingProfileId).toBeNull()
    expect(event.estimatedCostAmount).toBeNull()
  })

  it('should not fail run if token emission fails', async () => {
    // Setup: mock emitTokenLedgerEvent to throw
    // Execute run
    // Assert: run still completes successfully
    // Assert: error logged but run status = 'completed'
  })

  it('should emit events for tool calls', async () => {
    // Execute run with tool usage
    const events = await prisma.tokenLedgerEvent.findMany({
      where: { taskId: run.task.id },
    })

    // Should have model event + tool events
    expect(events.length).toBeGreaterThanOrEqual(2)
    const toolEvents = events.filter((e) => e.operationType === 'tool-translation')
    expect(toolEvents.length).toBeGreaterThan(0)
  })
})
```

### E2E Test Scenario

**File**: `e2e/token-ledger-flow.test.ts`

```typescript
describe('Token Ledger E2E', () => {
  it('should track usage from message submission to cost reporting', async () => {
    // 1. Bootstrap: create org, user, channel
    const org = await setupOrg()

    // 2. Create pricing profile
    await client.post('/api/ledger/tokens/pricing', {
      provider: 'anthropic',
      modelPattern: 'claude-*',
      currency: 'USD',
      inputPerMillion: 0.003,
      outputPerMillion: 0.015,
    })

    // 3. Submit message → triggers run → worker processes
    const threadId = await createThread()
    const response = await client.post(`/api/threads/${threadId}/messages`, {
      content: 'Hello, what is 2+2?',
      agentId: testAgentId,
    })
    expect(response.status).toBe(201)

    // 4. Wait for worker to complete run
    await waitForRunCompletion(response.data.data.runId)

    // 5. Verify token event was recorded
    const summary = await client.get('/api/ledger/tokens/summary', {
      params: {
        organizationId: org.id,
        from: new Date(Date.now() - 60000).toISOString(),
        to: new Date().toISOString(),
      },
    })

    expect(summary.data.data.summary.totalInputTokens).toBeGreaterThan(0)
    expect(summary.data.data.summary.totalEstimatedCost).toBeGreaterThan(0)
    expect(summary.data.data.summary.estimatedCurrency).toBe('USD')

    // 6. Verify admin can view monthly estimate
    const estimate = await client.get('/api/ledger/tokens/monthly-estimate', {
      params: { organizationId: org.id },
    })

    expect(estimate.data.data.mtd.estimatedCost).toBeGreaterThan(0)
  })
})
```

---

## 8. Deliverables Checklist

### Prisma / Database
- [ ] Token ledger event model added
- [ ] Model pricing profile model added
- [ ] Foreign key relationships established
- [ ] Indexes created for query performance
- [ ] Migration created and tested locally
- [ ] Seed script for provider-default pricing profiles
- [ ] Schema validated via `prisma validate`

### Worker
- [ ] `worker/src/services/token-ledger.ts` created with:
  - `emitTokenLedgerEvent()`
  - `resolvePricingProfile()`
  - `calculateEstimatedCost()`
- [ ] Integration in `executeRunJob()`:
  - Emit after model stream (line ~619)
  - Emit for each tool execution
  - Handle errors gracefully (log, don't fail run)
- [ ] Type imports from @nessie/schemas
- [ ] Tests passing for token event emission
- [ ] Worker lint passes
- [ ] Worker typecheck passes

### API
- [ ] All 6 endpoints implemented in `api/src/index.ts`:
  - POST /api/ledger/tokens/events
  - GET /api/ledger/tokens/summary
  - GET /api/ledger/tokens/events
  - GET /api/ledger/tokens/pricing
  - POST /api/ledger/tokens/pricing
  - DELETE /api/ledger/tokens/pricing/{profileId}
  - GET /api/ledger/tokens/monthly-estimate
- [ ] Permission checks (owner vs. team owner vs. member)
- [ ] Query parameter validation
- [ ] Error responses with appropriate codes
- [ ] Tests passing for all endpoints
- [ ] API lint passes
- [ ] API typecheck passes
- [ ] API production build passes

### Schemas (packages/schemas)
- [ ] TokenLedgerEvent schema and type added
- [ ] ModelPricingProfile schema and type added
- [ ] TokenUsage schema added
- [ ] Cost schema added
- [ ] PricingSnapshot schema added
- [ ] Request/response schemas for each endpoint
- [ ] All exports listed in index.ts
- [ ] Lint passes
- [ ] Typecheck passes

### Admin UI (minimal for Phase 2)
- [ ] `admin/src/facades/tokenLedger.ts` with hooks:
  - useTokenLedgerSummary
  - useTokenLedgerEvents
  - useTokenLedgerMonthlyEstimate
  - useTokenLedgerPricingProfiles
  - useCreatePricingProfile
  - useDeletePricingProfile
- [ ] `admin/src/pages/TokenLedgerPage.tsx` (stub with data display)
- [ ] `admin/src/pages/PricingProfilesPage.tsx` (stub with list)
- [ ] `admin/src/providers/TokenLedgerProvider.tsx` (context)
- [ ] Routes added to router.tsx
- [ ] Admin lint passes
- [ ] Admin typecheck passes

### Documentation
- [ ] Prisma schema comments updated
- [ ] API endpoint documentation in code or separate doc
- [ ] Token ledger event format documented
- [ ] Pricing profile lookup algorithm documented
- [ ] Cost calculation logic documented (formulas)

### Testing
- [ ] Unit tests for token-ledger service
- [ ] Integration tests for all API endpoints
- [ ] Worker token emission tests
- [ ] E2E scenario test (message → ledger event → report)
- [ ] All tests passing
- [ ] Coverage for edge cases:
  - Missing pricing profile
  - No provider usage reported
  - Concurrent submissions
  - Worker crash recovery
- [ ] Load test for high-volume event ingestion (optional for Phase 2)

### Quality Gates
- [ ] `/api` lint passes
- [ ] `/api` typecheck passes
- [ ] `/api` build passes
- [ ] `/worker` lint passes
- [ ] `/worker` typecheck passes
- [ ] `/worker` build passes
- [ ] `/admin` lint passes
- [ ] `/admin` typecheck passes
- [ ] `/admin` build passes
- [ ] `packages/schemas` lint passes
- [ ] `packages/schemas` typecheck passes
- [ ] Root ESLint flat config verified
- [ ] Prettier formatting consistent
- [ ] No dead code or unused imports

---

## 9. Risk Summary and Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Provider doesn't report usage | Cost estimates unavailable | Store NULL; document in UI; emit ops alert |
| Worker crashes before ledger emit | Untracked usage | Emit before run status update; best-effort logging |
| Pricing profile lookup too slow | API latency | Index `(organization_id, provider, model_pattern)` and use cache layer (Redis) in Phase 3 |
| Concurrent bulk ingestion | DB lock/timeout | Use async queue in `POST /events`; batch inserts |
| Large monthly aggregations | Slow query | Pre-compute daily rollups in background job; store in dedicated summary table (Phase 3) |
| Team-override pricing not ready | Incomplete feature | Scope Phase 2 to org-level overrides only; implement team overrides in Phase 3 |
| Admin UI complexity | Over-scope | Build minimal pages; add advanced filtering in Phase 3 |

---

## 10. Phase 2 Exit Criteria

Token Ledger feature is **READY FOR PHASE 2** only when:

1. ✓ All Prisma models created and migrated
2. ✓ All 7 API endpoints implemented and tested
3. ✓ Worker emits events for model calls and tool executions
4. ✓ All schema types added to packages/schemas
5. ✓ Admin UI facades and pages created (minimal)
6. ✓ Unit, integration, and E2E tests passing
7. ✓ All linting, typechecking, and builds passing
8. ✓ Edge cases handled gracefully (no silent failures)
9. ✓ Code reviewed by Claude CLI, Codex, max
10. ✓ No verified blocking findings from reviewers

---

## Summary

The Token Ledger feature specification is **comprehensive and well-designed**. Implementation requires:

- **~300 lines** Prisma schema (models + relations)
- **~400 lines** worker token ledger service
- **~500 lines** API routes (7 endpoints)
- **~200 lines** schema types
- **~300 lines** admin facade hooks + pages
- **~600 lines** test coverage

**Estimated effort**: 3–4 days for a full-stack developer. Start with Prisma + worker, then API, then UI.

**Success criteria**: Token events persist, pricing profiles resolve, cost estimates calculate, and admin can view monthly reports.
