# Agent Designer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the simple "create agent" dialog with a full Agent Designer page featuring an AI-assisted chat that can control every form field in real-time with streaming token updates.

**Architecture:** Two-column page (70% form / 30% chat). The chat hits a new `POST /api/designer/chat` SSE endpoint that calls OpenAI with tool definitions mirroring every form field. Tool call argument deltas stream directly into form fields. On save, `POST /api/agents` creates the agent in the user's personal collection.

**Tech Stack:** React, OpenAI Chat Completions (streaming + function calling), SSE, Fastify, existing `packages/runtime` ModelClient

---

### Task 1: Backend — Designer chat SSE endpoint

**Files:**
- Create: `api/src/routes/designer.ts`
- Modify: `api/src/index.ts` (register route)
- Modify: `api/src/contracts.ts` (add request schema)

**Step 1: Add request/response schemas to contracts.ts**

Add to `api/src/contracts.ts`:

```typescript
export const DesignerChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})

export const DesignerFormStateSchema = z.object({
  name: z.string(),
  role: z.string(),
  systemPrompt: z.string(),
  categoryId: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  tools: z.record(z.string(), z.boolean()),
})

export const DesignerChatBodySchema = z.object({
  messages: z.array(DesignerChatMessageSchema),
  formState: DesignerFormStateSchema,
})
```

**Step 2: Create the designer route module**

Create `api/src/routes/designer.ts`. This module:

1. Exports a Fastify plugin that registers `POST /api/designer/chat`
2. Validates the request body against `DesignerChatBodySchema`
3. Builds an OpenAI chat completions request with:
   - A system prompt describing the agent designer role and all available form fields
   - The current form state injected as context
   - The conversation history
   - Tool definitions for every form field: `set_name`, `set_role`, `set_system_prompt`, `set_category`, `set_provider`, `set_model`, `toggle_tool`
4. Calls OpenAI with `stream: true` and `tools` parameter
5. Relays the stream as SSE events:
   - `event: text.delta` + `data: {"content":"..."}` for assistant text chunks
   - `event: tool_call.start` + `data: {"id":"...","name":"set_system_prompt"}` when a tool call begins
   - `event: tool_call.delta` + `data: {"id":"...","args":"..."}` for streaming tool call argument fragments
   - `event: tool_call.done` + `data: {"id":"...","name":"...","args":{...}}` when tool call arguments are complete
   - `event: done` + `data: {}` when the stream ends

The OpenAI streaming response format with tools:
- `choices[0].delta.tool_calls[i].id` — appears on first chunk for that tool call
- `choices[0].delta.tool_calls[i].function.name` — appears on first chunk
- `choices[0].delta.tool_calls[i].function.arguments` — streams incrementally as JSON string fragments

The route must accumulate argument fragments per tool call ID, emit `tool_call.delta` for each fragment, and emit `tool_call.done` with the fully parsed JSON args when `[DONE]` is reached.

**OpenAI tool definitions to include:**

```typescript
const DESIGNER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_name',
      description: 'Set the agent name',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_role',
      description: 'Set the agent role (e.g. assistant, reviewer, analyst)',
      parameters: { type: 'object', properties: { role: { type: 'string' } }, required: ['role'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_system_prompt',
      description: 'Set or replace the agent system prompt. This is the main instruction text that defines agent behavior.',
      parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_category',
      description: 'Assign the agent to a category by ID, or null to unassign',
      parameters: { type: 'object', properties: { categoryId: { type: ['string', 'null'] } }, required: ['categoryId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_provider',
      description: 'Set the LLM provider (openai or minimax)',
      parameters: { type: 'object', properties: { provider: { type: 'string', enum: ['openai', 'minimax'] } }, required: ['provider'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_model',
      description: 'Set the LLM model name (e.g. gpt-4o, gpt-4o-mini)',
      parameters: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'toggle_tool',
      description: 'Enable or disable a tool for this agent',
      parameters: {
        type: 'object',
        properties: {
          toolId: { type: 'string', description: 'Tool identifier (e.g. bash, file-read, file-write, glob, grep, web-search)' },
          enabled: { type: 'boolean' },
        },
        required: ['toolId', 'enabled'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch_toggle_tools',
      description: 'Enable or disable multiple tools at once',
      parameters: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            items: {
              type: 'object',
              properties: { toolId: { type: 'string' }, enabled: { type: 'boolean' } },
              required: ['toolId', 'enabled'],
            },
          },
        },
        required: ['tools'],
      },
    },
  },
]
```

**Designer system prompt** (injected as first message):

```
You are an AI agent designer assistant. You help users configure AI agents by modifying their properties through tool calls.

Current form state:
- Name: {formState.name || "(empty)"}
- Role: {formState.role || "(empty)"}
- System prompt: {formState.systemPrompt || "(empty)"}
- Category: {formState.categoryId || "none"}
- Provider: {formState.provider}
- Model: {formState.model}
- Tools enabled: {list of enabled tool IDs}

Available tools the agent can be granted:
- System tools: bash, file-read, file-write, glob, grep, web-search

When the user describes what kind of agent they want, use your tools to configure the form fields. Write detailed system prompts that give the agent clear instructions for its purpose. Always explain what you're changing and why.

When writing system prompts, be thorough — include the agent's purpose, constraints, tone, output format expectations, and any domain-specific instructions.
```

**Step 3: Register the route in api/src/index.ts**

Import and register the designer plugin:
```typescript
import { designerRoutes } from './routes/designer.js'
// ...
app.register(designerRoutes)
```

**Step 4: Commit**

```
feat(api): add designer chat SSE endpoint with tool streaming
```

---

### Task 2: Backend — Agent update endpoint (PATCH)

**Files:**
- Modify: `api/src/index.ts` (add PATCH route)
- Modify: `api/src/contracts.ts` (add schema)

There is no PATCH endpoint for agents. We need one so that the save flow can update an already-created agent, and for future use. However, for the initial designer flow, we create on save via the existing `POST /api/agents`. We still need to extend the POST to accept `toolPolicy`.

**Step 1: Extend CreateAgentBodySchema**

In `api/src/contracts.ts`, add `toolPolicy` to the create schema:

```typescript
export const CreateAgentBodySchema = z.object({
  name: NonEmptyStringSchema,
  role: NonEmptyStringSchema.optional(),
  systemPrompt: z.string().optional(),
  parentAgentId: z.string().optional(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
})
```

**Step 2: Pass toolPolicy through in the POST handler**

In `api/src/index.ts`, find the POST /api/agents handler and ensure `toolPolicy` is passed to the Prisma create call as JSON.

**Step 3: Commit**

```
feat(api): accept toolPolicy in agent creation
```

---

### Task 3: Frontend — Route, page shell, and navigation

**Files:**
- Create: `admin/src/pages/AgentDesignerPage.tsx`
- Modify: `admin/src/router.tsx` (add route)
- Modify: `admin/src/components/features/agents/AgentColumnBrowser.tsx` (change button to navigate)
- Delete: `admin/src/components/features/agents/CreateAgentDialog.tsx`

**Step 1: Create the page shell**

Create `admin/src/pages/AgentDesignerPage.tsx` with a two-column layout:

```tsx
export const AgentDesignerPage = () => {
  return (
    <div className="flex h-full">
      {/* Agent form — 70% */}
      <div className="flex h-full w-[70%] flex-col border-r border-[color:var(--sep)]">
        <div className="flex h-[50px] items-center justify-between border-b border-[color:var(--sep)] px-6">
          <h2 className="text-sm font-semibold text-white">Agent Designer</h2>
          <div className="flex gap-2">
            <button className="admin-button admin-button-secondary">Cancel</button>
            <button className="admin-button admin-button-primary">Create agent</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {/* Form fields go here (Task 4) */}
        </div>
      </div>

      {/* Chat — 30% */}
      <div className="flex h-full w-[30%] flex-col">
        <div className="flex h-[50px] items-center border-b border-[color:var(--sep)] px-4">
          <h3 className="text-sm font-semibold text-white">Design Assistant</h3>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* Chat messages go here (Task 6) */}
        </div>
        <div className="border-t border-[color:var(--sep)] p-3">
          {/* Chat input goes here (Task 6) */}
        </div>
      </div>
    </div>
  )
}
```

**Step 2: Add route**

In `admin/src/router.tsx`, add inside the `AdminShellLayout` children:

```tsx
import { AgentDesignerPage } from './pages/AgentDesignerPage'
// ...
{
  path: '/agents/new',
  element: <AgentDesignerPage />,
},
```

**Step 3: Change the + button to navigate**

In `AgentColumnBrowser.tsx`:
- Remove `CreateAgentDialog` import and rendering
- Remove `createAgentOpen` state
- Change the header action button's `onClick` to navigate:

```tsx
import { useNavigate } from 'react-router-dom'
// ...
const navigate = useNavigate()
// ...
onClick={() => navigate('/agents/new')}
```

**Step 4: Delete CreateAgentDialog.tsx**

Remove `admin/src/components/features/agents/CreateAgentDialog.tsx`.

**Step 5: Build and verify**

```bash
pnpm --filter @nessie/admin build
```

**Step 6: Commit**

```
feat(admin): add agent designer page shell and route
```

---

### Task 4: Frontend — Agent form (left panel)

**Files:**
- Create: `admin/src/components/features/agents/designer/AgentDesignerForm.tsx`
- Create: `admin/src/components/features/agents/designer/useAgentDesigner.ts` (shared state hook)

**Step 1: Create the shared state hook**

`useAgentDesigner.ts` manages all form state that both the form and chat need to read/write:

```typescript
export type AgentFormState = {
  name: string
  role: string
  systemPrompt: string
  categoryId: string | null
  provider: string
  model: string
  tools: Record<string, boolean>
}

export type AgentDesignerActions = {
  setName: (name: string) => void
  setRole: (role: string) => void
  setSystemPrompt: (prompt: string) => void
  setCategoryId: (id: string | null) => void
  setProvider: (provider: string) => void
  setModel: (model: string) => void
  toggleTool: (toolId: string, enabled: boolean) => void
  applyPatch: (field: string, value: unknown) => void
}
```

Use `useReducer` for atomic updates. The `applyPatch` function maps tool call names to state updates — this is what the chat stream calls.

Default state:
```typescript
const DEFAULT_STATE: AgentFormState = {
  name: '',
  role: 'assistant',
  systemPrompt: '',
  categoryId: null,
  provider: 'openai',
  model: 'gpt-4o',
  tools: {
    'bash': false,
    'file-read': false,
    'file-write': false,
    'glob': false,
    'grep': false,
    'web-search': false,
  },
}
```

**Step 2: Create the form component**

`AgentDesignerForm.tsx` renders all fields using the shared state:

- **Name**: `<input>` with `admin-input` class
- **Role**: `<input>` with `admin-input` class
- **Category**: `<select>` dropdown populated from `useAgentCategories()` + static options
- **Provider**: `<select>` with openai/minimax options
- **Model**: `<input>` with `admin-input` class
- **System prompt**: `<textarea>` with `admin-input` class, 12+ rows, monospace font
- **Tools**: collapsible category sections (see Task 5)

Each field binds to the shared state and updates via the actions. The system prompt textarea should have a CSS transition/highlight effect when being updated by the chat (a brief accent border pulse).

**Step 3: Commit**

```
feat(admin): add agent designer form and state hook
```

---

### Task 5: Frontend — Tool checkboxes with collapsible categories

**Files:**
- Create: `admin/src/components/features/agents/designer/ToolCategorySection.tsx`

**Step 1: Define tool categories**

```typescript
export const TOOL_CATEGORIES = [
  {
    id: 'system',
    name: 'System',
    description: 'Core built-in tools',
    tools: [
      { id: 'bash', name: 'Bash', description: 'Execute shell commands' },
      { id: 'file-read', name: 'File Read', description: 'Read file contents' },
      { id: 'file-write', name: 'File Write', description: 'Write files' },
      { id: 'glob', name: 'Glob', description: 'Find files by pattern' },
      { id: 'grep', name: 'Grep', description: 'Search file contents' },
      { id: 'web-search', name: 'Web Search', description: 'Search the internet' },
    ],
  },
] as const
```

**Step 2: Build the collapsible section component**

`ToolCategorySection.tsx`:
- Category header with chevron toggle, category name, and "N/M enabled" count
- Clicking header toggles expanded/collapsed state (default: expanded for first category)
- Each tool row: checkbox + name + description
- Checkbox state bound to `tools[toolId]` from shared state
- Animate expand/collapse with `max-height` transition

**Step 3: Commit**

```
feat(admin): add collapsible tool category checkboxes
```

---

### Task 6: Frontend — Designer chat panel

**Files:**
- Create: `admin/src/components/features/agents/designer/DesignerChat.tsx`
- Create: `admin/src/facades/designer/hooks.ts`

**Step 1: Create the designer chat hook**

`hooks.ts` — `useDesignerChat(formState, onPatch)`:

- Manages conversation messages: `Array<{ role: 'user' | 'assistant', content: string }>`
- `sendMessage(content)` function that:
  1. Appends user message to history
  2. Calls `POST /api/designer/chat` with fetch (SSE mode)
  3. Processes the SSE stream:
     - `text.delta`: Accumulates assistant text, updates the "streaming" message
     - `tool_call.start`: Records active tool call
     - `tool_call.delta`: Calls `onPatch(toolName, argsDelta)` with the incremental argument fragment — this is how the form fields update token-by-token
     - `tool_call.done`: Calls `onPatch(toolName, parsedArgs)` with final parsed args for a clean state set
     - `done`: Finalizes assistant message in history
  4. Returns abort controller for cancellation

**Step 2: Create the chat component**

`DesignerChat.tsx`:
- Scrollable message list at the top (flex-1 overflow-y-auto)
- Each message: styled bubble (user right-aligned accent, assistant left-aligned panel bg)
- Streaming assistant message shows pulsing cursor
- Tool call indicators inline: "Setting system prompt..." with a spinner
- Input area at bottom: textarea + send button
- Enter sends (Shift+Enter newline)
- Disable input while streaming

**Step 3: Commit**

```
feat(admin): add designer chat panel with SSE streaming
```

---

### Task 7: Frontend — Wire streaming patches to form

**Files:**
- Modify: `admin/src/pages/AgentDesignerPage.tsx` (connect everything)
- Modify: `admin/src/components/features/agents/designer/useAgentDesigner.ts` (add streaming text accumulator)

**Step 1: Implement the streaming patch handler**

The `onPatch` callback from the chat hook receives incremental tool call argument fragments. For text fields (especially `set_system_prompt`), we need to accumulate the JSON string fragments and extract the partial text value.

The OpenAI tool call argument stream looks like:
```
{"con    →  fragment 1
tent":  →  fragment 2
"You a  →  fragment 3
re a h  →  fragment 4
elpful  →  fragment 5
..."    →  fragment N
}       →  final fragment
```

The state hook needs a `streamingField` concept:
- When `tool_call.start` fires for `set_system_prompt`, mark `systemPrompt` as "streaming"
- On each `tool_call.delta`, attempt to extract partial string value from accumulated JSON args
- Update the field value progressively (the textarea shows text appearing token by token)
- On `tool_call.done`, set the final clean value and clear the streaming flag
- While streaming, the textarea gets a visual indicator (accent border + subtle glow)

For non-text fields (`toggle_tool`, `set_category`), the `tool_call.done` event applies the change instantly.

**Step 2: Connect form + chat in the page**

In `AgentDesignerPage.tsx`:
```tsx
const { state, actions } = useAgentDesigner()
const chat = useDesignerChat(state, actions.applyPatch)

return (
  <div className="flex h-full">
    <div className="w-[70%] ...">
      <AgentDesignerForm state={state} actions={actions} />
    </div>
    <div className="w-[30%] ...">
      <DesignerChat chat={chat} />
    </div>
  </div>
)
```

**Step 3: Build and verify**

```bash
pnpm --filter @nessie/admin build
```

**Step 4: Commit**

```
feat(admin): wire streaming patches from chat to agent form
```

---

### Task 8: Frontend — Save flow

**Files:**
- Modify: `admin/src/pages/AgentDesignerPage.tsx`

**Step 1: Implement save**

The "Create agent" button:
1. Calls `useCreateAgent().mutateAsync({ name, role, systemPrompt, toolPolicy: tools })`
2. If `categoryId` is set, calls `useAddAgentToCategory().mutateAsync({ categoryId, agentId })`
3. On success, navigates to `/agents`

The "Cancel" button navigates back to `/agents`.

Validation: name is required. Show inline error if empty on save attempt.

**Step 2: Build and verify with Playwright**

Navigate to `/agents`, click + Agent, verify the designer page loads. Fill in fields, verify chat works, save and confirm navigation back.

**Step 3: Commit**

```
feat(admin): add save and cancel flow to agent designer
```

---

### Task 9: Visual polish and Playwright verification

**Files:**
- Modify: `admin/src/styles.css` (if needed for new classes)
- Various component tweaks

**Step 1: Visual verification**

Use Playwright to:
1. Navigate to `/agents`
2. Click the "+ Agent" button
3. Verify the designer page renders with 70/30 split
4. Verify form fields are present and functional
5. Verify chat panel renders
6. Type a message in chat, verify streaming response
7. Verify form fields update from chat tool calls
8. Click save, verify navigation back to agents list

**Step 2: Fix any visual issues**

Ensure consistent styling with the rest of the admin (dark theme, `--sep` borders, `--panel` backgrounds, `--accent` highlights).

**Step 3: Final commit**

```
feat(admin): polish agent designer page
```

---

## File summary

**New files:**
- `api/src/routes/designer.ts` — SSE endpoint for designer chat
- `admin/src/pages/AgentDesignerPage.tsx` — Page shell
- `admin/src/components/features/agents/designer/useAgentDesigner.ts` — Shared form state
- `admin/src/components/features/agents/designer/AgentDesignerForm.tsx` — Form panel
- `admin/src/components/features/agents/designer/ToolCategorySection.tsx` — Collapsible tool checkboxes
- `admin/src/components/features/agents/designer/DesignerChat.tsx` — Chat panel
- `admin/src/facades/designer/hooks.ts` — Chat SSE hook

**Modified files:**
- `api/src/index.ts` — Register designer route
- `api/src/contracts.ts` — Add schemas
- `admin/src/router.tsx` — Add `/agents/new` route
- `admin/src/components/features/agents/AgentColumnBrowser.tsx` — Navigate instead of dialog
- `admin/src/styles.css` — Any new utility classes

**Deleted files:**
- `admin/src/components/features/agents/CreateAgentDialog.tsx`
