# `orchestrate.decide` Queue Job Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move agent-engagement orchestration out of the HTTP request path and into a durable, retryable `orchestrate.decide` queue job so that `POST /api/threads/:threadId/messages` returns 201 immediately after persisting the user message.

**Architecture:** The API handler stores the message, enqueues an `orchestrate.decide` job (carrying all context the worker needs), and returns 201. The worker job calls `decideAgentEngagement`, creates runs/tasks for `'reply'` decisions inside a Prisma transaction, upserts reactions for `'acknowledge'` decisions, and enqueues `run.execute` jobs. `decideAgentEngagement` moves from `api/src/services/orchestrator.ts` to `packages/runtime/src/orchestrator.ts` so both api and worker share it without circular deps. `withActionContext` moves to `@nessie/schemas` to avoid duplication.

**Tech Stack:** TypeScript strict, Fastify, Prisma, Zod, PostgreSQL queue (`queue_jobs` table), `PgQueueProvider` / `PgRealtimeTransport` from `@nessie/runtime`, `@nessie/schemas`.

---

## Context & Current State

### What exists today
- `api/src/services/orchestrator.ts` — exports `decideAgentEngagement`, `OrchestratorAgent`, `OrchestratorDecision`
- `api/src/queue/pgqueue.ts` — exports `enqueueQueueJob`, `enqueueRunExecution`
- `worker/src/queue.ts` — same `enqueueQueueJob` / `enqueueRunExecution` (pre-existing duplication, out of scope)
- `api/src/index.ts` line ~3992 — fire-and-forget IIFE wrapping all orchestration (interim fix from prior session)
- `api/src/index.ts` line 431 — `withActionContext` defined locally (pure helper, never extracted)

### Critical correctness issue: @mention resolution
`createThreadMessage` in `api/src/services/messages.ts` resolves **@mentioned agents not bound to the channel** and appends them to `result.channelAgents`. If the worker re-fetches agent bindings from the DB it will miss those agents. Solution: **include `channelAgents` in the job payload** (fully resolved at API time, including @mentions).

### Critical correctness issue: run deduplication on retry
The queue worker retries jobs on failure (max 3 attempts). If a `'reply'` decision's run/task creation succeeds but a subsequent operation fails (e.g., `publishWs`), the job nacks. On retry `run.create` executes again, producing a second run → the agent replies twice. Fix: wrap `run.create + task.create + enqueueRunExecution` in a `prisma.$transaction()`. If any step fails, all are rolled back, leaving no orphaned state for the retry.

### Relevant file map
| File | Role |
|---|---|
| `api/src/index.ts` | Route handler — to simplify |
| `api/src/services/orchestrator.ts` | Source of `decideAgentEngagement` — to delete |
| `api/src/queue/pgqueue.ts` | API queue helpers — add `enqueueOrchestrateDecide` |
| `packages/runtime/src/orchestrator.ts` | NEW — shared home for `decideAgentEngagement` |
| `packages/runtime/src/index.ts` | Add `export * from './orchestrator.js'` |
| `packages/schemas/src/index.ts` | Export `withActionContext`; add `OrchestrateDecideJobPayloadSchema` |
| `worker/src/run/orchestrate.ts` | NEW — job handler |
| `worker/src/index.ts` | Register `orchestrate.decide` subscription |

---

## Task 0: Move `withActionContext` to `@nessie/schemas`

**Why first:** AGENTS.md requires refactoring before reuse. The function is used in `api/src/index.ts` and will be needed in the new worker handler. It is a pure function with no deps beyond `AuthorizedActionContext` (which lives in schemas). This is the right home.

**Files:**
- Modify: `packages/schemas/src/index.ts`
- Modify: `api/src/index.ts`

**Step 1: Add `withActionContext` to `packages/schemas/src/index.ts`**

Add after the `AuthorizedActionContext` type export (around line 759):

```typescript
export const withActionContext = (
  actorContext: AuthorizedActionContext,
  fields: Partial<AuthorizedActionContext['actionContext']>,
): AuthorizedActionContext => ({
  ...actorContext,
  actionContext: { ...actorContext.actionContext, ...fields },
})
```

**Step 2: Update `api/src/index.ts`**

Remove the local definition (lines 431–440):
```typescript
const withActionContext = (
  actorContext: AuthorizedActionContext,
  fields: Partial<AuthorizedActionContext['actionContext']>,
): AuthorizedActionContext => ({
  ...actorContext,
  actionContext: {
    ...actorContext.actionContext,
    ...fields,
  },
})
```

Add `withActionContext` to the existing `@nessie/schemas` import block at the top of the file.

**Step 3: Build & lint**
```bash
pnpm --filter @nessie/schemas build
pnpm --filter @nessie/api build
pnpm --filter @nessie/api lint
```
Expected: clean.

**Step 4: Commit**
```bash
git add packages/schemas/src/index.ts api/src/index.ts
git commit -m "refactor(schemas): extract withActionContext to @nessie/schemas"
```

---

## Task 1: Move `decideAgentEngagement` to `packages/runtime`

**Why:** The worker needs this function but cannot import from `api/`. Runtime has no circular dep risk — the function only uses `ModelClient` and `ModelMessage` which are both defined in runtime's own `model.ts`.

**Files:**
- Create: `packages/runtime/src/orchestrator.ts`
- Modify: `packages/runtime/src/index.ts`
- Delete: `api/src/services/orchestrator.ts`
- Modify: `api/src/index.ts` (update import)

**Step 1: Create `packages/runtime/src/orchestrator.ts`**

Exact content — copy verbatim, only the import path changes:

```typescript
import type { ModelClient, ModelMessage } from './model.js'

export type OrchestratorAgent = {
  id: string
  name: string
  role: string
  systemPrompt: string | null
}

export type OrchestratorDecision =
  | { action: 'reply'; agentId: string }
  | { action: 'acknowledge'; agentId: string; emoji: string }
  | { action: 'none' }

/**
 * Invisible channel orchestrator. Reads a user message, considers which
 * bound agents are present and what they do, and decides if/how an agent
 * should engage.
 *
 * Returns an array of decisions so a single message can @mention multiple
 * agents and have each one respond. An empty array means no action.
 *
 * Rules:
 * - If the message @mentions only users (no agents): no action
 * - If the message @mentions one or more agents by name: reply for each
 * - Otherwise: ask the LLM which agent (if any) should engage
 */
export const decideAgentEngagement = async (
  modelClient: ModelClient,
  input: {
    agents: OrchestratorAgent[]
    content: string
    recentMessages: Array<{ role: string; content: string; agentName?: string }>
  },
): Promise<OrchestratorDecision[]> => {
  if (input.agents.length === 0) {
    return []
  }

  // Fast path: collect every agent explicitly @mentioned.
  const mentionedReplies: OrchestratorDecision[] = []
  const mentionedIds = new Set<string>()
  for (const agent of input.agents) {
    const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`@${escaped}(?:\\s|$|[^\\w])`, 'i').test(input.content)) {
      if (!mentionedIds.has(agent.id)) {
        mentionedIds.add(agent.id)
        mentionedReplies.push({ action: 'reply', agentId: agent.id })
      }
    }
  }
  if (mentionedReplies.length > 0) {
    return mentionedReplies
  }

  // If there are @mentions but no agent matched, assume user-to-user — stay silent
  if (/@\w/.test(input.content)) {
    return []
  }

  // LLM decision: should any agent engage?
  const agentDescriptions = input.agents
    .map(
      (a) =>
        `- "${a.name}" (id: ${a.id}, role: ${a.role}): ${a.systemPrompt?.slice(0, 120) ?? 'general assistant'}`,
    )
    .join('\n')

  const conversationContext = input.recentMessages
    .slice(-5)
    .map((msg) => `${msg.agentName ?? msg.role}: ${msg.content.slice(0, 150)}`)
    .join('\n')

  const systemMsg: ModelMessage = {
    content: [
      'You are an invisible channel orchestrator.',
      'Your ONLY job is to decide whether one of the available',
      'agents should respond to the latest user message.',
      '',
      'Available agents in this channel:',
      agentDescriptions,
      '',
      'Rules:',
      '1. If the message is clearly directed at or relevant to',
      '   one agent\'s expertise, return:',
      '   {"action":"reply","agentId":"<id>"}',
      '2. If the latest message is a direct question',
      '   (e.g. ends with "?", or starts with what/why/how/when/where/who)',
      '   AND any agent has participated in the recent conversation OR',
      '   has expertise matching the question\'s topic, return',
      '   {"action":"reply","agentId":"<id>"}',
      '   — pick the agent most recently active on that topic.',
      '   Treat a leading filler like "hey" as throat-clearing,',
      '   not as addressing a specific human.',
      '3. If the message is a short acknowledgement of agent work',
      '   (e.g. "thanks", "ok", "noted") that does not need a full',
      '   reply, return:',
      '   {"action":"acknowledge","agentId":"<id>","emoji":"<emoji>"}',
      '4. If the message is clearly a conversation between users,',
      '   a greeting to a specific named human,',
      '   or not relevant to any agent, return: {"action":"none"}',
      '5. When the topic is unclear AND no agent is contextually',
      '   relevant, return: {"action":"none"}.',
      '   Agents should not intrude on purely human conversations,',
      '   but they SHOULD answer direct questions in their own',
      '   working channels.',
      '',
      'Return ONLY valid JSON. No explanation.',
    ].join('\n'),
    role: 'system',
  }

  const userMsg: ModelMessage = {
    content: [
      conversationContext ? `Recent conversation:\n${conversationContext}\n` : '',
      `Latest message: ${input.content}`,
    ].join('\n'),
    role: 'user',
  }

  // Reasoning models (gpt-5-mini etc.) spend most of the budget on hidden
  // thinking tokens before they emit the final JSON. 128 is nowhere near
  // enough — the call errors out with "max_tokens reached". Give it real
  // headroom; the visible output is still only ~40 tokens.
  let raw: string
  try {
    raw = await modelClient.chat([systemMsg, userMsg], { maxTokens: 2048, temperature: 0.1 })
  } catch {
    // A router failure must never block a user message from being stored.
    // Fall back to "no action" and let the user re-prompt or @mention.
    return []
  }

  try {
    const parsed = JSON.parse(raw.trim()) as { action?: string; agentId?: string; emoji?: string }
    if (parsed.action === 'reply' && input.agents.some((a) => a.id === parsed.agentId)) {
      return [{ action: 'reply', agentId: parsed.agentId! }]
    }
    if (
      parsed.action === 'acknowledge' &&
      parsed.emoji &&
      input.agents.some((a) => a.id === parsed.agentId)
    ) {
      return [{ action: 'acknowledge', agentId: parsed.agentId!, emoji: String(parsed.emoji) }]
    }
    return []
  } catch {
    return []
  }
}
```

**Step 2: Export from `packages/runtime/src/index.ts`**

Add at the end:
```typescript
export * from './orchestrator.js'
```

**Step 3: Delete the old file**
```bash
rm api/src/services/orchestrator.ts
```

**Step 4: Update `api/src/index.ts`**

Replace:
```typescript
import { decideAgentEngagement } from './services/orchestrator.js'
```
With (add to the existing `@nessie/runtime` import block):
```typescript
import { decideAgentEngagement } from '@nessie/runtime'
```

The fire-and-forget IIFE still calls `decideAgentEngagement` until Task 4 replaces it, so the import is used and ESLint will not flag it as unused.

**Step 5: Build & lint**
```bash
pnpm --filter @nessie/runtime build
pnpm --filter @nessie/api build
pnpm --filter @nessie/api lint
```
Expected: clean. Zero references to `./services/orchestrator`:
```bash
grep -r "services/orchestrator" api/src/
```
Expected: no output.

**Step 6: Commit**
```bash
git add packages/runtime/src/orchestrator.ts packages/runtime/src/index.ts api/src/index.ts
git commit -m "refactor(orchestrator): move decideAgentEngagement to @nessie/runtime"
```

---

## Task 2: Add `OrchestrateDecideJobPayloadSchema` to `@nessie/schemas`

**Why:** Both the API (enqueue) and worker (parse) need a shared schema. Schemas has no circular dep risk — it depends only on `zod`.

**Files:**
- Modify: `packages/schemas/src/index.ts`

**Step 1: Add schema after the `RunExecuteJobPayloadSchema` block (around line 774)**

```typescript
export const OrchestrateDecideJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  /**
   * Resolved agent list as computed by createThreadMessage — includes bound
   * agents AND any @mentioned agents not yet bound to the channel.
   * Stored in payload so the worker does not re-derive (would miss @mentions).
   */
  channelAgents: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string().min(1),
      role: z.string().min(1),
      systemPrompt: z.string().nullable(),
    }),
  ),
  channelId: ChannelIdSchema,
  content: z.string().min(1),
  messageId: z.string().uuid(),
  role: z.string().min(1),
  threadId: ThreadIdSchema,
})
export type OrchestrateDecideJobPayload = z.infer<typeof OrchestrateDecideJobPayloadSchema>
```

> **Note on `messageId`:** Uses `z.string().uuid()` (not the internal `NonEmptyStringSchema`) for stronger validation consistent with the UUID primary key from Prisma.

**Step 2: Build**
```bash
pnpm --filter @nessie/schemas build
```
Expected: clean.

**Step 3: Commit**
```bash
git add packages/schemas/src/index.ts
git commit -m "feat(schemas): add OrchestrateDecideJobPayloadSchema"
```

---

## Task 3: Add `enqueueOrchestrateDecide` to `api/src/queue/pgqueue.ts`

**Files:**
- Modify: `api/src/queue/pgqueue.ts`

**Step 1: Add import at top of file**

```typescript
import type { OrchestrateDecideJobPayload } from '@nessie/schemas'
```

**Step 2: Add function after `enqueueRunExecution`**

```typescript
export const enqueueOrchestrateDecide = async (
  prisma: Pick<PrismaClient, '$executeRaw'>,
  payload: OrchestrateDecideJobPayload,
  idempotencyKey?: string,
): Promise<boolean> => {
  return enqueueQueueJob(prisma, {
    idempotencyKey,
    payload,
    topic: 'orchestrate.decide',
  })
}
```

**Step 3: Build & lint**
```bash
pnpm --filter @nessie/api build
pnpm --filter @nessie/api lint
```
Expected: clean.

**Step 4: Commit**
```bash
git add api/src/queue/pgqueue.ts
git commit -m "feat(queue): add enqueueOrchestrateDecide helper"
```

---

## Task 4: Simplify API route handler in `api/src/index.ts`

Replace the fire-and-forget IIFE with a single `enqueueOrchestrateDecide` call. The enqueue is wrapped in a try/catch so that a transient DB failure during job insertion **never** surfaces as a "failed" message on the client — the user message was already persisted.

**Files:**
- Modify: `api/src/index.ts`

**Step 1: Update the `./queue/pgqueue.js` import**

Add `enqueueOrchestrateDecide` to the existing import that already has `enqueueRunExecution`.

**Step 2: Remove the temporary `decideAgentEngagement` import from `@nessie/runtime`**

Added in Task 1 Step 4 — it is no longer called in the API after this step.

**Step 3: Replace the fire-and-forget IIFE block**

Find and remove the entire block starting with:
```typescript
    // Kick off agent engagement without blocking the 201 response.
```
through its closing `}` (just before `return reply.code(201).send(...)`).

Replace with:

```typescript
    // Enqueue agent-engagement decision — durable, retryable, never blocks this
    // response. The try/catch ensures a transient queue-insert failure cannot
    // surface as a "failed" badge on an already-persisted user message.
    if (result.channelAgents.length > 0) {
      try {
        await enqueueOrchestrateDecide(
          prisma,
          {
            actorContext,
            channelAgents: result.channelAgents,
            channelId: parseChannelId(thread.channel.id),
            content: body.content,
            messageId: result.message.id,
            role: result.message.role,
            threadId: parseThreadId(thread.id),
          },
          `orchestrate:${result.message.id}`,
        )
      } catch (err) {
        app.log.error(
          { err, messageId: result.message.id },
          '[orchestrate] failed to enqueue decide job — agent will not respond',
        )
      }
    }
```

> **Why no `sharedModelClient` guard:** The worker has its own `modelClient`. If the model is unconfigured, `decideAgentEngagement` falls through its own try/catch returning `[]` — no run is created. Enqueueing always is correct; the worker decides whether to act.

**Step 4: Build & lint**
```bash
pnpm --filter @nessie/api build
pnpm --filter @nessie/api lint
```
Expected: clean. Confirm no remaining references to the old IIFE variables or `decideAgentEngagement`:
```bash
grep -n "decideAgentEngagement\|capturedResult\|capturedThread\|capturedContent\|capturedActorContext" api/src/index.ts
```
Expected: no output.

**Step 5: Commit**
```bash
git add api/src/index.ts
git commit -m "feat(api): enqueue orchestrate.decide instead of fire-and-forget LLM call"
```

---

## Task 5: Create `worker/src/run/orchestrate.ts`

The core job handler. Receives the payload, fetches only what it cannot infer from it (recent messages for LLM context), makes the LLM decision, then applies it atomically via a Prisma transaction.

**Files:**
- Create: `worker/src/run/orchestrate.ts`

**Step 1: Write the handler**

```typescript
import {
  decideAgentEngagement,
  type OrchestratorAgent,
  type PgRealtimeTransport,
  type ModelClient,
} from '@nessie/runtime'
import {
  type OrchestrateDecideJobPayload,
  parseAgentId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'
import { enqueueRunExecution } from '../queue.js'

export type OrchestrateDecideDeps = {
  modelClient: ModelClient
  prisma: PrismaClient
  realtimeTransport: PgRealtimeTransport
}

export const executeOrchestrateDecideJob = async (
  deps: OrchestrateDecideDeps,
  payload: OrchestrateDecideJobPayload,
): Promise<void> => {
  const { actorContext, channelAgents, channelId, content, messageId, role, threadId } = payload

  // Belt-and-suspenders guard — API already checks before enqueueing.
  if (channelAgents.length === 0) {
    return
  }

  // Fetch the last 6 messages for orchestrator context. The most recent one
  // is the triggering message (already persisted before this job was enqueued).
  // After .reverse(), it sits at the end; .slice(0, -1) removes it so the LLM
  // sees only prior conversation history.
  const recentDbMessages = await deps.prisma.message.findMany({
    where: { threadId },
    orderBy: { createdAt: 'desc' },
    take: 6,
    include: { agent: { select: { name: true } } },
  })

  const recentMessages = recentDbMessages
    .reverse()
    .slice(0, -1)
    .map((m) => ({
      role: m.role,
      content: m.content,
      agentName: m.agent?.name ?? undefined,
    }))

  const decisions = await decideAgentEngagement(deps.modelClient, {
    // channelAgents from the payload is structurally identical to OrchestratorAgent[].
    // The Zod schema shape and the type both require { id, name, role, systemPrompt }.
    agents: channelAgents satisfies OrchestratorAgent[],
    content,
    recentMessages,
  })

  if (decisions.length === 0) {
    return
  }

  const scopes = [
    {
      kind: 'organization' as const,
      organizationId: actorContext.tenant.organizationId,
    },
    {
      kind: 'channel' as const,
      // channelId is already ChannelId-branded from the payload schema — no re-parse needed.
      channelId,
    },
  ]

  for (const decision of decisions) {
    if (decision.action === 'reply') {
      // Wrap run + task creation and job enqueueing in a transaction.
      // If any step fails the whole unit rolls back, leaving no orphaned run
      // for the retry to trip over.
      const { run, task } = await deps.prisma.$transaction(async (tx) => {
        const createdRun = await tx.run.create({
          data: {
            agentId: decision.agentId,
            // threadId is ThreadId-branded; Prisma's generated types accept branded strings
            // because the brand is a compile-time-only structural extension of string.
            threadId,
            status: 'pending',
          },
          select: { agentId: true, id: true, status: true, threadId: true },
        })

        const createdTask = await tx.task.create({
          data: {
            runId: createdRun.id,
            agentId: decision.agentId,
            status: 'inbox',
            purpose: content.slice(0, 200),
          },
          select: { id: true },
        })

        await enqueueRunExecution(
          tx,
          {
            actorContext: withActionContext(actorContext, {
              // run.agentId and run.threadId are plain strings from Prisma — parse needed.
              agentId: parseAgentId(createdRun.agentId),
              channelId,
              taskId: parseTaskId(createdTask.id),
              threadId: parseThreadId(createdRun.threadId),
            }),
            agentId: parseAgentId(createdRun.agentId),
            messageId,
            runId: parseRunId(createdRun.id),
            taskId: parseTaskId(createdTask.id),
            threadId: parseThreadId(createdRun.threadId),
          },
          // Deterministic key: if this job retries (e.g., publishWs fails after
          // the transaction commits), a second run.create produces a new run.id.
          // Using messageId+agentId prevents the duplicate run.execute from being
          // enqueued, so the agent does not reply twice even if a second run row
          // is created as an orphan.
          `run:${messageId}:${decision.agentId}`,
        )

        return { run: createdRun, task: createdTask }
      })

      // Publish outside the transaction — pg_notify cannot be rolled back, but
      // the run/task are now durably committed so the event is correct.
      await deps.realtimeTransport.publishWs(
        [
          ...scopes,
          { kind: 'agent' as const, agentId: parseAgentId(run.agentId) },
        ],
        {
          data: {
            agentId: parseAgentId(run.agentId),
            contentPreview: content.slice(0, 200),
            messageId,
            role,
            threadId: parseThreadId(run.threadId),
          },
          event: 'message.new',
        },
      )

      console.log(
        JSON.stringify({
          event: 'orchestrate.reply',
          agentId: run.agentId,
          runId: run.id,
          taskId: task.id,
          messageId,
          threadId,
        }),
      )
    }

    if (decision.action === 'acknowledge') {
      await deps.prisma.messageReaction.upsert({
        where: {
          messageId_agentId_emoji: {
            messageId,
            agentId: decision.agentId,
            emoji: decision.emoji,
          },
        },
        update: {},
        create: {
          messageId,
          agentId: decision.agentId,
          emoji: decision.emoji,
        },
      })

      const reactionData = {
        messageId,
        agentId: parseAgentId(decision.agentId),
        emoji: decision.emoji,
      }

      // threadId is branded ThreadId; publishSse accepts string — brands are
      // structural subtypes of string so this is both type-safe and correct.
      await deps.realtimeTransport.publishSse(threadId, 'message.reaction', reactionData)
      await deps.realtimeTransport.publishWs(scopes, {
        data: reactionData,
        event: 'message.reaction',
      })

      console.log(
        JSON.stringify({
          event: 'orchestrate.acknowledge',
          agentId: decision.agentId,
          emoji: decision.emoji,
          messageId,
        }),
      )
    }
  }
}
```

**Step 2: Build worker**
```bash
pnpm --filter @nessie/worker build
pnpm --filter @nessie/worker lint
```
Expected: clean.

**Step 3: Commit**
```bash
git add worker/src/run/orchestrate.ts
git commit -m "feat(worker): add executeOrchestrateDecideJob handler"
```

---

## Task 6: Register `orchestrate.decide` subscription in `worker/src/index.ts`

**Files:**
- Modify: `worker/src/index.ts`

**Step 1: Add imports**

To the existing schemas import block, add:
```typescript
OrchestrateDecideJobPayloadSchema,
```

Add alongside existing run imports:
```typescript
import { executeOrchestrateDecideJob } from './run/orchestrate.js'
```

**Step 2: Add subscription block after the `run.execute` subscription**

```typescript
  queueProvider.subscribe(
    'orchestrate.decide',
    async (job) => {
      const payload = OrchestrateDecideJobPayloadSchema.parse(job.payload)
      await executeOrchestrateDecideJob(
        { modelClient, prisma, realtimeTransport },
        payload,
      )
    },
    { signal: abortController.signal },
  )
```

**Step 3: Build & lint worker**
```bash
pnpm --filter @nessie/worker build
pnpm --filter @nessie/worker lint
```
Expected: clean.

**Step 4: Verify the full affected package graph builds**

Run each affected package explicitly rather than the root `pnpm build` script (which runs legacy lint and may fail on unrelated issues):
```bash
pnpm --filter @nessie/schemas build
pnpm --filter @nessie/runtime build
pnpm --filter @nessie/api build
pnpm --filter @nessie/worker build
```
Expected: all clean.

**Step 5: Commit**
```bash
git add worker/src/index.ts
git commit -m "feat(worker): subscribe to orchestrate.decide queue topic"
```

---

## Task 7: End-to-end smoke test

**Step 1: Start API and worker**
```bash
# Terminal 1
pnpm --filter @nessie/api dev

# Terminal 2
pnpm --filter @nessie/worker dev
```

**Step 2: Send a plain message**

Open `http://localhost:5555`, go to the General channel, type `hello` and send.

Expected:
1. Message appears immediately — no latency before it shows up (201 returns before any LLM work)
2. Within 1–2 seconds, the agent starts streaming a reply
3. No "failed" badge on the user message under any conditions

**Step 3: Verify queue job in DB**
```sql
SELECT topic, status, payload->>'messageId', enqueued_at, completed_at
FROM queue_jobs
WHERE topic = 'orchestrate.decide'
ORDER BY enqueued_at DESC
LIMIT 5;
```
Expected: rows with `status = 'done'`.

**Step 4: Verify @mention routing**

Send `@DadJokeBot tell me a joke`. The @mention fast-path should engage DadJokeBot directly (no LLM orchestration call, just the regex match).

**Step 5: Verify transaction rollback protection (optional)**

Temporarily break `task.create` in the worker (e.g., pass invalid `runId`). Send a message. Confirm no orphaned run is left in `pending` status:
```sql
SELECT id, status, created_at FROM runs ORDER BY created_at DESC LIMIT 5;
```

Restore the worker code after.

---

## Edge Cases & Failure Modes

| Scenario | Behaviour |
|---|---|
| `enqueueOrchestrateDecide` DB error | Caught by try/catch in API handler — logged, 201 still returned, agent will not respond to this message |
| Worker model client unconfigured / API key missing | `decideAgentEngagement` try/catch returns `[]` → job completes with no run created; logged at worker startup |
| Agent deleted between message creation and job execution | `prisma.run.create` throws FK violation → transaction rolled back → job nacks → retried up to 3× → goes `dead` → no reply, user message persists |
| Idempotency key collision (double-enqueue) | `ON CONFLICT DO NOTHING` → second insert silently skipped, only one orchestration runs |
| `publishWs` fails AFTER transaction commits | Run/task are committed; WS event missed but `run.execute` is already enqueued and will fire. Job nacks and retries; on retry a second run row may be created (orphan), but the deterministic idempotency key `run:<messageId>:<agentId>` prevents a second `run.execute` from being enqueued → agent replies exactly once. The orphan run stays in `pending` indefinitely (harmless for a personal-scale system). |
| Worker restart mid-job (before ack) | 5-min lock expires → job re-claimed → same retry behaviour as above. |
| Queue job `dead` after 3 attempts | No agent reply; user can re-send or @mention the agent directly |
| Multiple agents @mentioned (multiple decisions) | Each decision processed sequentially in the for-loop. Failure on decision[1] does not roll back decision[0]'s committed transaction |

## Known Limitations (not fixed in this plan)

- **No backoff on retry**: Failed jobs are retried on the next 1-second poll cycle. For transient LLM failures this burns 3 attempts in ~3 seconds before the job goes dead. Same as all other job types in this codebase.
- **Race condition on context**: Up to 1 second elapses between message creation and worker execution. A second user message sent in that window will appear in the worker's recent-messages fetch but be excluded by the `.slice(0, -1)` logic, giving the orchestrator slightly stale context. Harmless in practice.
- **`publishWs` failure window**: See edge cases table above. Very low probability.

## What Does NOT Change

- `POST /api/threads/:threadId/messages` contract (same 201 + body)
- `run.execute` job schema and worker handler
- `createThreadMessage` and @mention resolution logic
- `worker/src/queue.ts` duplication (pre-existing, out of scope)
- Admin frontend — no changes needed
