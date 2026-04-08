# Channel Orchestrator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every channel gets an invisible orchestrator that reads each user message and decides which (if any) bound agents should engage, and how -- full reply, emoji acknowledgement, or silence.

**Architecture:** The orchestrator is not an agent entity. It's an infrastructure layer that runs after every user message is saved. It uses a cheap/fast LLM call (ModelClient.chat) with the channel's bound agents (names + roles + systemPrompt summaries) to produce a structured JSON decision. The decision drives dispatch: create a Run for a full reply, insert a MessageReaction record for an emoji ack, or do nothing. Reactions are stored in a new `message_reactions` table and rendered under messages in the admin UI.

**Tech Stack:** Prisma (schema + migration), ModelClient.chat (OpenAI gpt-5-mini), Fastify endpoints, React Query, Tailwind CSS, existing WebSocket event system.

---

### Task 1: Add MessageReaction table to Prisma schema

**Files:**
- Modify: `api/prisma/schema.prisma:240-255` (Message model -- add reactions relation)
- Modify: `api/prisma/schema.prisma` (add MessageReaction model after Message)

**Step 1: Add the MessageReaction model and relation**

In `api/prisma/schema.prisma`, add after the Message model's closing brace (after line 255):

```prisma
model MessageReaction {
  id        String   @id @default(uuid()) @db.Uuid
  messageId String   @map("message_id") @db.Uuid
  agentId   String?  @map("agent_id") @db.Uuid
  userId    String?  @map("user_id") @db.Uuid
  emoji     String
  createdAt DateTime @default(now()) @map("created_at")
  message   Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
  agent     Agent?   @relation(fields: [agentId], references: [id], onDelete: SetNull)
  user      User?    @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@unique([messageId, agentId, emoji])
  @@unique([messageId, userId, emoji])
  @@index([messageId])
  @@map("message_reactions")
}
```

Add the reverse relations to the existing models:

In `Message` model (line 250, before the `@@index` lines):
```prisma
  reactions MessageReaction[]
```

In `Agent` model (line 276, before `@@map`):
```prisma
  reactions         MessageReaction[]
```

In `User` model (find it, add before `@@map`):
```prisma
  reactions         MessageReaction[]
```

**Step 2: Generate migration**

Run: `cd api && npx prisma migrate dev --name add_message_reactions`
Expected: Migration file created, database schema updated.

**Step 3: Commit**

```bash
git add api/prisma/
git commit -m "feat(schema): add message_reactions table"
```

---

### Task 2: Add reaction API types and endpoints

**Files:**
- Modify: `api/src/contracts.ts` (add reaction schemas)
- Modify: `api/src/services/messages.ts` (add reaction service functions)
- Modify: `api/src/index.ts` (add reaction endpoints)

**Step 1: Add reaction schemas to contracts.ts**

After `ThreadMessageRecordSchema` (line 152):

```typescript
export const MessageReactionRecordSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
  agentId: AgentIdSchema.nullish(),
  userId: z.string().uuid().nullish(),
  emoji: z.string(),
  createdAt: TimestampSchema,
})
export type MessageReactionRecord = z.infer<typeof MessageReactionRecordSchema>
```

Update `ThreadMessageRecordSchema` to include reactions:

```typescript
export const ThreadMessageRecordSchema = z.object({
  id: z.string().uuid(),
  threadId: ThreadIdSchema,
  agentId: AgentIdSchema.nullish(),
  userId: z.string().uuid().nullish(),
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: TimestampSchema,
  reactions: MessageReactionRecordSchema.array().optional(),
})
```

**Step 2: Add reaction service functions to messages.ts**

```typescript
export const addReaction = async (
  prisma: PrismaClient,
  input: {
    messageId: string
    agentId?: string
    userId?: string
    emoji: string
  },
) => {
  return prisma.messageReaction.upsert({
    where: input.agentId
      ? { messageId_agentId_emoji: { messageId: input.messageId, agentId: input.agentId, emoji: input.emoji } }
      : { messageId_userId_emoji: { messageId: input.messageId, userId: input.userId!, emoji: input.emoji } },
    update: {},
    create: {
      messageId: input.messageId,
      agentId: input.agentId ?? null,
      userId: input.userId ?? null,
      emoji: input.emoji,
    },
  })
}
```

Update `listThreadMessages` to include reactions:

```typescript
const messages = await prisma.message.findMany({
  where: { threadId },
  orderBy: { createdAt: 'asc' },
  include: { reactions: true },
})
```

Update `mapThreadMessageRecord` to include reactions.

**Step 3: Add endpoint in index.ts**

After the `POST /api/threads/:threadId/messages` handler:

```typescript
app.post('/api/threads/:threadId/messages/:messageId/reactions', async (request, reply) => {
  // ... auth, parse body { emoji: string }, call addReaction, publish WS event 'message.reaction'
})
```

**Step 4: Commit**

```bash
git add api/src/contracts.ts api/src/services/messages.ts api/src/index.ts
git commit -m "feat(api): add message reaction endpoints and types"
```

---

### Task 3: Build the channel orchestrator service

This is the core decision engine. It lives in a new file and is called from the message creation flow.

**Files:**
- Create: `api/src/services/orchestrator.ts`

**Step 1: Create the orchestrator**

```typescript
import type { ModelClient, ModelMessage } from '@nessie/runtime'

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
 * Rules:
 * - If the message @mentions only users (no agents): action = 'none'
 * - If the message @mentions an agent by name: action = 'reply' for that agent
 * - Otherwise: ask the LLM which agent (if any) should engage
 */
export const decideAgentEngagement = async (
  modelClient: ModelClient,
  input: {
    agents: OrchestratorAgent[]
    content: string
    recentMessages: Array<{ role: string; content: string; agentName?: string }>
  },
): Promise<OrchestratorDecision> => {
  if (input.agents.length === 0) {
    return { action: 'none' }
  }

  // Fast path: explicit @mention detection
  const mentionPattern = /@([\w][\w\s]*[\w]|[\w]+)/g
  const mentions: string[] = []
  for (const match of input.content.matchAll(mentionPattern)) {
    if (match[1]) mentions.push(match[1])
  }

  if (mentions.length > 0) {
    const mentionedAgent = input.agents.find((a) =>
      mentions.some((name) => a.name.toLowerCase() === name.toLowerCase()),
    )
    if (mentionedAgent) {
      return { action: 'reply', agentId: mentionedAgent.id }
    }
    // Mentions exist but none match agents -- users only
    return { action: 'none' }
  }

  // LLM decision: should any agent engage?
  const agentDescriptions = input.agents
    .map((a) => `- "${a.name}" (${a.role}): ${a.systemPrompt?.slice(0, 120) ?? 'general assistant'}`)
    .join('\n')

  const conversationContext = input.recentMessages
    .slice(-5)
    .map((msg) => `${msg.agentName ?? msg.role}: ${msg.content.slice(0, 150)}`)
    .join('\n')

  const systemMsg: ModelMessage = {
    content: [
      'You are an invisible channel orchestrator. Your ONLY job is to decide whether one of the available agents should respond to the latest user message.',
      '',
      'Available agents in this channel:',
      agentDescriptions,
      '',
      'Rules:',
      '1. If the message is clearly directed at or relevant to one agent\'s expertise, return: {"action":"reply","agentId":"<id>"}',
      '2. If the message is a general statement that doesn\'t need a full reply but an agent could acknowledge it (e.g. "thanks", "ok", "noted", "please acknowledge"), return: {"action":"acknowledge","agentId":"<id>","emoji":"<single emoji>"}',
      '3. If the message is a conversation between users, a greeting to a specific person, or not relevant to any agent, return: {"action":"none"}',
      '4. When in doubt, return {"action":"none"}. Agents should not intrude on human conversations.',
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

  const raw = await modelClient.chat([systemMsg, userMsg])

  try {
    const parsed = JSON.parse(raw.trim())
    if (parsed.action === 'reply' && input.agents.some((a) => a.id === parsed.agentId)) {
      return { action: 'reply', agentId: parsed.agentId }
    }
    if (parsed.action === 'acknowledge' && parsed.emoji && input.agents.some((a) => a.id === parsed.agentId)) {
      return { action: 'acknowledge', agentId: parsed.agentId, emoji: String(parsed.emoji) }
    }
    return { action: 'none' }
  } catch {
    return { action: 'none' }
  }
}
```

**Step 2: Commit**

```bash
git add api/src/services/orchestrator.ts
git commit -m "feat(api): add channel orchestrator decision engine"
```

---

### Task 4: Wire orchestrator into message creation flow

**Files:**
- Modify: `api/src/index.ts:1027-1120` (POST /api/threads/:threadId/messages handler)
- Modify: `api/src/services/messages.ts` (simplify -- remove dispatch logic)

**Step 1: Refactor createThreadMessage to stop making dispatch decisions**

The `createThreadMessage` function should no longer make dispatch decisions. It saves the message and returns the channel's agent data so the caller (index.ts) can pass it to the orchestrator.

In `api/src/services/messages.ts`, simplify `createThreadMessage`:
- Always create the message
- Return `channelAgents` array (id, name, role, systemPrompt) alongside the message
- Do NOT create Run/Task here anymore (the orchestrator in index.ts will decide)

New return type:

```typescript
export type CreateThreadMessageResult =
  | {
      kind: 'created'
      message: Message
      channelAgents: Array<{
        id: string
        name: string
        role: string
        systemPrompt: string | null
      }>
    }
  | { kind: 'thread_not_found' }
```

Remove the `extractMentions` function, `selectedBinding` logic, and Run/Task creation from `createThreadMessage`. Those concerns move to the orchestrator + index.ts.

**Step 2: Update the POST handler in index.ts**

After `createThreadMessage` returns the message + channelAgents:

```typescript
import { decideAgentEngagement } from './services/orchestrator.js'

// Fetch recent messages for context
const recentMessages = await prisma.message.findMany({
  where: { threadId: thread.id },
  orderBy: { createdAt: 'desc' },
  take: 5,
  include: { agent: { select: { name: true } } },
})

const decision = await decideAgentEngagement(modelClient, {
  agents: result.channelAgents,
  content: body.content,
  recentMessages: recentMessages.reverse().map((m) => ({
    role: m.role,
    content: m.content,
    agentName: m.agent?.name ?? undefined,
  })),
})

if (decision.action === 'reply') {
  // Create Run + Task for the chosen agent, enqueue execution
  const run = await prisma.run.create({ ... })
  const task = await prisma.task.create({ ... })
  await enqueueRunExecution(prisma, { ... })
}

if (decision.action === 'acknowledge') {
  // Insert reaction, publish WS event
  await addReaction(prisma, {
    messageId: result.message.id,
    agentId: decision.agentId,
    emoji: decision.emoji,
  })
  await realtimeHub.publishWs(scopes, {
    data: { messageId: result.message.id, agentId: decision.agentId, emoji: decision.emoji },
    event: 'message.reaction',
  })
}

// action === 'none' -> return message, no engagement
```

**Step 3: Build and verify**

Run: `pnpm --filter @nessie/api build`
Expected: Clean build with no TS errors.

**Step 4: Commit**

```bash
git add api/src/index.ts api/src/services/messages.ts
git commit -m "feat(api): wire orchestrator into message dispatch flow"
```

---

### Task 5: Add ModelClient to API process for orchestrator

**Files:**
- Modify: `api/src/index.ts` (create model client, pass to orchestrator)

**Step 1: Create model client in API**

The model client currently lives in the worker process only (`worker/src/index.ts`). The API process needs its own instance for the orchestrator's cheap `chat()` calls.

In `api/src/index.ts`, near the top where dependencies are initialized:

```typescript
import { createModelClient } from '@nessie/runtime'

const modelClient = createModelClient({
  apiKey: process.env.OPENAI_CHAT_API_KEY ?? process.env.OPENAI_API_KEY,
  provider: 'openai',
})
```

Pass `modelClient` to the orchestrator call in the POST handler.

**Step 2: Build and test**

Run: `pnpm --filter @nessie/api build`

**Step 3: Commit**

```bash
git add api/src/index.ts
git commit -m "feat(api): add model client for orchestrator LLM calls"
```

---

### Task 6: Add reaction rendering to admin frontend

**Files:**
- Modify: `admin/src/lib/api-client.ts` (update ThreadMessageRecord type to include reactions)
- Modify: `admin/src/pages/ChannelsPage.tsx:526-530` (render reactions under messages)
- Modify: `admin/src/styles.css` (reaction pill styles)
- Modify: `admin/src/facades/threads/hooks.ts` (handle reaction SSE events)

**Step 1: Update the frontend ThreadMessageRecord type**

In `admin/src/lib/api-client.ts`, add to `ThreadMessageRecord`:

```typescript
export type MessageReaction = {
  id: string
  messageId: string
  agentId?: string
  userId?: string
  emoji: string
  createdAt: string
}

export type ThreadMessageRecord = {
  // ... existing fields ...
  reactions?: MessageReaction[]
}
```

**Step 2: Render reactions under message content**

In `ChannelsPage.tsx`, after the `<p>` tag that renders `renderContent(item.message.content)` (around line 529), add:

```tsx
{item.message.reactions?.length ? (
  <div className="mt-1 flex flex-wrap gap-1">
    {Object.entries(
      item.message.reactions.reduce<Record<string, number>>((acc, r) => {
        acc[r.emoji] = (acc[r.emoji] ?? 0) + 1
        return acc
      }, {}),
    ).map(([emoji, count]) => (
      <span key={emoji} className="reaction-pill">
        {emoji} {count > 1 ? count : ''}
      </span>
    ))}
  </div>
) : null}
```

**Step 3: Add CSS for reaction pills**

In `admin/src/styles.css`:

```css
.reaction-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--sep);
  border-radius: 12px;
  background: rgba(124, 58, 237, 0.08);
  padding: 1px 8px;
  font-size: 13px;
  line-height: 1.6;
  cursor: default;
}
```

**Step 4: Handle realtime reaction events**

In `admin/src/facades/threads/hooks.ts`, in the SSE event loop (around line 106), add:

```typescript
if (event === 'message.reaction') {
  void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
}
```

**Step 5: Build and verify**

Run: `pnpm --filter @nessie/admin build`
Expected: Clean build.

**Step 6: Commit**

```bash
git add admin/src/
git commit -m "feat(admin): render message reactions with emoji pills"
```

---

### Task 7: End-to-end test with Playwright

**Step 1: Test mention-only message (no agent reply)**

1. Navigate to General channel
2. Type `hello @Owner` and send
3. Verify: No agent responds (orchestrator returns `action: 'none'`)

**Step 2: Test agent-addressed message (full reply)**

1. Type `@Builder what is TypeScript?`
2. Verify: Builder agent responds with a full reply

**Step 3: Test acknowledgement message (emoji reaction)**

1. Type `ok thanks everyone`
2. Verify: An agent adds a reaction emoji (e.g. thumbs up) under the message
3. Verify: The emoji pill renders correctly under the message

**Step 4: Test general question (LLM-routed reply)**

1. Type `Can someone explain how our deployment works?`
2. Verify: The most relevant agent (based on role/systemPrompt) responds

**Step 5: Screenshot and verify reaction rendering**

Take screenshots of messages with reaction pills to confirm visual correctness.

---

## Decision Matrix Summary

| Message Pattern | Orchestrator Decision | Result |
|---|---|---|
| `@Builder do X` | `reply` (Builder) | Builder gets a Run, responds fully |
| `@Owner hello` | `none` | No agent engages |
| `@Owner @Builder help` | `reply` (Builder) | Builder responds (agent mentioned) |
| `thanks everyone` | `acknowledge` (any) | Agent adds emoji reaction |
| `How does X work?` | `reply` (best match) | LLM picks most relevant agent |
| `hey @Owner how are you` | `none` | Only user mentioned |
| General chitchat | `none` | Agents stay quiet |
