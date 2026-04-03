# Helper Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a voice-first personal AI agent for macOS with multi-agent orchestration. Voice via OpenAI Realtime API (gpt-realtime-1.5), tool layer inspired by Claude Code, native macOS UI.

**Architecture:** Node.js/Bun TypeScript backend with tool layer + orchestrator. The voice layer connects to OpenAI Realtime API WebSocket. Sub-agents are spawned as separate processes. macOS app is SwiftUI.

**Tech Stack:** Bun/TypeScript, OpenAI Realtime API (gpt-realtime-1.5), SwiftUI (macOS), Apple Speech framework (hotword), NWPathMonitor (network detection).

---

## Phase 1: Project Foundation

### Task 1: Project Structure

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts` (entry point)

**Step 1: Create project files**

```json
// package.json
{
  "name": "helper-agent",
  "type": "module",
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build src/index.ts --outdir dist",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@openai/realtime-next": "latest"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0",
    "bun-types": "latest"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "types": ["bun-types"],
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
```

**Step 2: Install dependencies**

Run: `pnpm install`
Expected: node_modules created

**Step 3: Create entry point**

```typescript
// src/index.ts
console.log('Helper Agent starting...')
export {}
```

**Step 4: Verify it runs**

Run: `bun run src/index.ts`
Expected: "Helper Agent starting..."

---

### Task 2: Tool Layer — Core Interfaces

**Files:**
- Create: `src/tools/Tool.ts`
- Create: `src/tools/types.ts`

**Step 1: Write the types**

```typescript
// src/tools/types.ts
export type ToolResult<T> = {
  data: T
  newMessages?: Message[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
}

export type ToolUseContext = {
  abortController: AbortController
  messages: Message[]
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  options: {
    tools: Tools
    debug: boolean
  }
}

export type AppState = {
  isOnline: boolean
  isListening: boolean
  isSpeaking: boolean
  hotwordActive: boolean
  activeAgentId?: string
}

export type Tools = readonly Tool[]
```

**Step 2: Write the Tool interface**

```typescript
// src/tools/Tool.ts
import type { z } from 'zod'
import type { ToolResult, ToolUseContext, Tools } from './types.js'

export type Tool<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output = unknown,
> = {
  readonly name: string
  readonly inputSchema: z.ZodType<Input>
  readonly description: string
  readonly maxResultSizeChars: number

  call(
    args: Input,
    context: ToolUseContext,
  ): Promise<ToolResult<Output>>

  isConcurrencySafe(input: Input): boolean
  isReadOnly(input: Input): boolean
  isDestructive?(input: Input): boolean
  isEnabled(): boolean

  userFacingName(input: Partial<Input> | undefined): string
  getActivityDescription?(input: Partial<Input> | undefined): string | null
}

export type AnyTool = Tool<Record<string, unknown>, unknown>

export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => t.name === name)
}
```

**Step 3: Write the buildTool factory**

```typescript
// src/tools/Tool.ts (append after Tool interface)
export type ToolDef<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output = unknown,
> = Omit<Tool<Input, Output>, 'isConcurrencySafe' | 'isReadOnly' | 'isDestructive' | 'isEnabled' | 'userFacingName'> &
  Partial<Pick<Tool<Input, Output>, 'isConcurrencySafe' | 'isReadOnly' | 'isDestructive' | 'isEnabled' | 'userFacingName'>>

export function buildTool<Input extends Record<string, unknown>, Output>(
  def: ToolDef<Input, Output> & { name: string; inputSchema: z.ZodType<Input> }
): Tool<Input, Output> {
  return {
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    isEnabled: () => true,
    userFacingName: () => def.name,
    ...def,
  } as Tool<Input, Output>
}
```

**Step 4: Verify it compiles**

Run: `bun build src/tools/Tool.ts --outdir dist`
Expected: no errors

---

### Task 3: Tool Orchestration

**Files:**
- Create: `src/tools/orchestration.ts`

**Step 1: Write the orchestration logic**

```typescript
// src/tools/orchestration.ts
import { findToolByName, type Tool } from './Tool.js'
import type { ToolUseContext, ToolResult } from './types.js'

export type ToolUseBlock = {
  id: string
  name: string
  input: Record<string, unknown>
}

export type MessageUpdate = {
  message?: unknown
  newContext: ToolUseContext
}

export async function* runTools(
  toolUses: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  // Partition: read-only tools can run concurrently, writes run serially
  const batches = partitionToolCalls(toolUses, toolUseContext)

  for (const batch of batches) {
    if (batch.isConcurrencySafe) {
      yield* runToolsConcurrently(batch.blocks, toolUseContext)
    } else {
      yield* runToolsSerially(batch.blocks, toolUseContext)
    }
  }
}

type Batch = { isConcurrencySafe: boolean; blocks: ToolUseBlock[] }

function partitionToolCalls(toolUses: ToolUseBlock[], ctx: ToolUseContext): Batch[] {
  return toolUses.reduce<Batch[]>((acc, toolUse) => {
    const tool = findToolByName(ctx.options.tools, toolUse.name)
    const parsed = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsed?.success
      ? Boolean(tool?.isConcurrencySafe(parsed.data))
      : false

    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}

async function* runToolsSerially(
  toolUses: ToolUseBlock[],
  ctx: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = ctx
  for (const toolUse of toolUses) {
    const tool = findToolByName(ctx.options.tools, toolUse.name)
    if (!tool) {
      yield {
        message: { error: `No such tool: ${toolUse.name}` },
        newContext: currentContext,
      }
      continue
    }

    const parsed = tool.inputSchema.safeParse(toolUse.input)
    if (!parsed.success) {
      yield {
        message: { error: `Invalid input: ${parsed.error.message}` },
        newContext: currentContext,
      }
      continue
    }

    const result = await tool.call(parsed.data, currentContext)
    yield { message: { toolUseId: toolUse.id, result: result.data }, newContext: currentContext }
  }
}

async function* runToolsConcurrently(
  toolUses: ToolUseBlock[],
  ctx: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  await Promise.all(
    toolUses.map(async (toolUse) => {
      const tool = findToolByName(ctx.options.tools, toolUse.name)
      if (!tool) return
      const parsed = tool.inputSchema.safeParse(toolUse.input)
      if (!parsed.success) return
      await tool.call(parsed.data, ctx)
    })
  )
  yield { newContext: ctx }
}
```

---

## Phase 2: Core Tools

### Task 4: Bash Tool

**Files:**
- Create: `src/tools/BashTool.ts`

**Step 1: Write the BashTool**

```typescript
// src/tools/BashTool.ts
import { z } from 'zod'
import { buildTool, type Tool } from './Tool.js'
import type { ToolUseContext } from './types.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const BashToolSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
  timeout: z.number().optional(),
})

export type BashToolInput = z.infer<typeof BashToolSchema>

export function createBashTool(): Tool<BashToolInput, { stdout: string; stderr: string; exitCode: number }> {
  return buildTool({
    name: 'Bash',
    description: 'Execute a shell command on the system',
    inputSchema: BashToolSchema,

    async call(args, context) {
      const timeout = args.timeout ?? 30000
      try {
        const { stdout, stderr } = await execAsync(args.command, { timeout })
        return { data: { stdout, stderr, exitCode: 0 } }
      } catch (err: unknown) {
        const error = err as { stdout?: string; stderr?: string; code?: number }
        return {
          data: {
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? String(err),
            exitCode: error.code ?? 1,
          },
        }
      }
    },

    isConcurrencySafe() { return false },
    isReadOnly() { return false },

    userFacingName() { return 'Bash' },
    getActivityDescription(input) {
      return input?.description ?? `Running: ${(input?.command as string)?.split(' ')[0] ?? 'command'}`
    },
    maxResultSizeChars: 10_000,
  })
}

export const BashTool = createBashTool()
```

**Step 2: Write a quick smoke test**

```typescript
// src/tools/BashTool.test.ts
import { describe, test, expect } from 'bun:test'
import { createBashTool } from './BashTool.js'

describe('BashTool', () => {
  const tool = createBashTool()

  test('runs a simple command', async () => {
    const ctx = makeMockContext()
    const result = await tool.call({ command: 'echo hello' }, ctx)
    expect(result.data.stdout.trim()).toBe('hello')
  })

  test('reports errors', async () => {
    const ctx = makeMockContext()
    const result = await tool.call({ command: 'exit 1' }, ctx)
    expect(result.data.exitCode).toBe(1)
  })
})

function makeMockContext() {
  return {
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({}),
    setAppState: () => {},
    options: { tools: [], debug: false },
  } as any
}
```

**Step 3: Run the test**

Run: `bun test src/tools/BashTool.test.ts`
Expected: PASS

---

### Task 5: File Tools

**Files:**
- Create: `src/tools/FileReadTool.ts`
- Create: `src/tools/FileWriteTool.ts`

**Step 1: Write FileReadTool**

```typescript
// src/tools/FileReadTool.ts
import { z } from 'zod'
import { buildTool, type Tool } from './Tool.js'
import type { ToolUseContext } from './types.js'
import { readFile } from 'fs/promises'

const FileReadSchema = z.object({
  file_path: z.string(),
  limit: z.number().optional(),
  offset: z.number().optional(),
})

export type FileReadInput = z.infer<typeof FileReadSchema>

export function createFileReadTool(): Tool<FileReadInput, { content: string; file_path: string }> {
  return buildTool({
    name: 'FileRead',
    description: 'Read the contents of a file from the filesystem',
    inputSchema: FileReadSchema,

    async call(args, _ctx) {
      const content = await readFile(args.file_path, 'utf-8')
      const offset = args.offset ?? 0
      const limit = args.limit
      const sliced = limit ? content.slice(offset, offset + limit) : content.slice(offset)
      return { data: { content: sliced, file_path: args.file_path } }
    },

    isConcurrencySafe() { return true },
    isReadOnly() { return true },
    userFacingName: (input) => `Read ${input?.file_path ?? 'file'}`,
    getActivityDescription: (input) => `Reading ${input?.file_path ?? 'file'}`,
    maxResultSizeChars: 50_000,
  })
}

export const FileReadTool = createFileReadTool()
```

**Step 2: Write FileWriteTool**

```typescript
// src/tools/FileWriteTool.ts
import { z } from 'zod'
import { buildTool, type Tool } from './Tool.js'
import type { ToolUseContext } from './types.js'
import { writeFile } from 'fs/promises'

const FileWriteSchema = z.object({
  file_path: z.string(),
  content: z.string(),
})

export type FileWriteInput = z.infer<typeof FileWriteSchema>

export function createFileWriteTool(): Tool<FileWriteInput, { success: boolean; file_path: string }> {
  return buildTool({
    name: 'FileWrite',
    description: 'Write content to a file on the filesystem',
    inputSchema: FileWriteSchema,

    async call(args, _ctx) {
      await writeFile(args.file_path, args.content, 'utf-8')
      return { data: { success: true, file_path: args.file_path } }
    },

    isConcurrencySafe() { return false },
    isReadOnly() { return false },
    isDestructive() { return false }, // overwrites, doesn't delete
    userFacingName: (input) => `Write ${input?.file_path ?? 'file'}`,
    getActivityDescription: (input) => `Writing ${input?.file_path ?? 'file'}`,
    maxResultSizeChars: 1_000,
  })
}

export const FileWriteTool = createFileWriteTool()
```

---

### Task 6: File Find & Web Search Tools

**Files:**
- Create: `src/tools/GlobTool.ts`
- Create: `src/tools/GrepTool.ts`
- Create: `src/tools/WebSearchTool.ts`

**Step 1: Write GlobTool**

```typescript
// src/tools/GlobTool.ts
import { z } from 'zod'
import { buildTool, type Tool } from './Tool.js'
import type { ToolUseContext } from './types.js'
import { glob } from 'glob'

const GlobSchema = z.object({
  pattern: z.string(),
  cwd: z.string().optional(),
})

export type GlobInput = z.infer<typeof GlobSchema>

export function createGlobTool(): Tool<GlobInput, { files: string[] }> {
  return buildTool({
    name: 'Glob',
    description: 'Find files matching a glob pattern',
    inputSchema: GlobSchema,

    async call(args, _ctx) {
      const files = await glob(args.pattern, { cwd: args.cwd ?? process.cwd() })
      return { data: { files } }
    },

    isConcurrencySafe() { return true },
    isReadOnly() { return true },
    userFacingName: (input) => `Find ${input?.pattern ?? '*'}`,
    getActivityDescription: (input) => `Finding ${input?.pattern ?? '*'}`,
    maxResultSizeChars: 10_000,
  })
}

export const GlobTool = createGlobTool()
```

**Step 2: Write WebSearchTool (using fetch to a search endpoint)**

```typescript
// src/tools/WebSearchTool.ts
import { z } from 'zod'
import { buildTool, type Tool } from './Tool.js'
import type { ToolUseContext } from './types.js'

const WebSearchSchema = z.object({
  query: z.string(),
})

export type WebSearchInput = z.infer<typeof WebSearchSchema>

export function createWebSearchTool(): Tool<WebSearchInput, { results: Array<{ title: string; url: string; snippet: string }> }> {
  return buildTool({
    name: 'WebSearch',
    description: 'Search the web for information',
    inputSchema: WebSearchSchema,

    async call(args, _ctx) {
      // TODO: wire up to Mollotov MCP or search API
      // For now, returns empty — will be implemented properly in a later phase
      return {
        data: {
          results: [
            {
              title: `Search for: ${args.query}`,
              url: `https://duckduckgo.com/?q=${encodeURIComponent(args.query)}`,
              snippet: 'Web search not yet wired up — open the URL to search.',
            },
          ],
        },
      }
    },

    isConcurrencySafe() { return true },
    isReadOnly() { return true },
    userFacingName: (input) => `Search: ${input?.query ?? ''}`,
    getActivityDescription: (input) => `Searching for: ${input?.query ?? ''}`,
    maxResultSizeChars: 10_000,
  })
}

export const WebSearchTool = createWebSearchTool()
```

---

### Task 7: Tools Registry

**Files:**
- Create: `src/tools/index.ts`

```typescript
// src/tools/index.ts
import { BashTool } from './BashTool.js'
import { FileReadTool } from './FileReadTool.js'
import { FileWriteTool } from './FileWriteTool.js'
import { GlobTool } from './GlobTool.js'
import { WebSearchTool } from './WebSearchTool.js'
import type { Tools } from './Tool.js'

export const allTools: Tools = [
  BashTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  WebSearchTool,
]

export { BashTool, FileReadTool, FileWriteTool, GlobTool, WebSearchTool }
```

---

## Phase 3: Orchestrator Agent

### Task 8: Orchestrator Agent

**Files:**
- Create: `src/agent/Orchestrator.ts`
- Create: `src/agent/types.ts`

**Step 1: Write agent types**

```typescript
// src/agent/types.ts
export type AgentMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  audioData?: Uint8Array
  timestamp: number
}

export type SubAgentTask = {
  id: string
  name: string
  task: string
  tools: string[]  // tool names to assign
  status: 'pending' | 'running' | 'done' | 'failed'
  result?: string
  error?: string
}

export type OrchestratorState = {
  messages: AgentMessage[]
  subAgents: SubAgentTask[]
  isListening: boolean
  isSpeaking: boolean
  currentAgent: string
}
```

**Step 2: Write the orchestrator**

```typescript
// src/agent/Orchestrator.ts
import { allTools, type Tools } from '../tools/index.js'
import { findToolByName, type Tool } from '../tools/Tool.js'
import type { ToolUseContext, ToolUseBlock } from '../tools/orchestration.js'
import type { OrchestratorState, SubAgentTask, AgentMessage } from './types.js'

export class Orchestrator {
  private state: OrchestratorState
  private tools: Tools
  private callbacks: OrchestratorCallbacks

  constructor(options: OrchestratorOptions) {
    this.state = {
      messages: [],
      subAgents: [],
      isListening: false,
      isSpeaking: false,
      currentAgent: options.defaultAgent ?? 'main',
    }
    this.tools = allTools
    this.callbacks = options.callbacks
  }

  getState(): OrchestratorState {
    return this.state
  }

  setTools(tools: Tools) {
    this.tools = tools
  }

  async handleUserMessage(content: string): Promise<string> {
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: Date.now(),
    }
    this.state.messages.push(message)

    // Decide what to do based on message content
    const action = this.decideAction(content)

    switch (action.type) {
      case 'voice':
        return await this.handleVoiceResponse(content)
      case 'inject':
        return await this.handleKeyboardInject(action.text)
      case 'subagent':
        return await this.handleSubAgentTask(action.task, action.tools ?? [])
      default:
        return `I heard: ${content}`
    }
  }

  private decideAction(content: string): { type: 'voice' | 'inject' | 'subagent' | 'direct'; text?: string; task?: string; tools?: string[] } {
    const lower = content.toLowerCase()
    if (lower.includes('search') || lower.includes('find') || lower.includes('look up') || lower.includes('research')) {
      return { type: 'subagent', task: content, tools: ['WebSearch', 'Bash', 'FileRead', 'Glob'] }
    }
    if (lower.includes('type this') || lower.includes('write in') || lower.includes('fill in')) {
      return { type: 'inject', text: content.replace(/type this|write in|fill in/gi, '').trim() }
    }
    return { type: 'voice' }
  }

  private async handleVoiceResponse(text: string): Promise<string> {
    // TODO: wire up to OpenAI Realtime API — returns text for now
    return `Processing: ${text}`
  }

  private async handleKeyboardInject(text: string): Promise<string> {
    await this.callbacks.injectToActiveApp?.(text)
    return `Injected: ${text}`
  }

  private async handleSubAgentTask(task: string, toolNames: string[]): Promise<string> {
    const subAgent: SubAgentTask = {
      id: crypto.randomUUID(),
      name: `research-${Date.now()}`,
      task,
      tools: toolNames,
      status: 'running',
    }
    this.state.subAgents.push(subAgent)

    // Spawn the sub-agent (see Task 9)
    const result = await this.spawnSubAgent(subAgent)
    subAgent.status = 'done'
    subAgent.result = result

    return `Research complete: ${result}`
  }

  private async spawnSubAgent(task: SubAgentTask): Promise<string> {
    // TODO: spawn as child process or thread
    // For now, run synchronously
    const toolUseContext = this.makeContext()
    const toolUse: ToolUseBlock = {
      id: task.id,
      name: 'WebSearch',
      input: { query: task.task },
    }

    const tool = findToolByName(this.tools, toolUse.name)
    if (!tool) return `Tool not found: ${toolUse.name}`

    const parsed = tool.inputSchema.safeParse(toolUse.input)
    if (!parsed.success) return `Invalid input: ${parsed.error.message}`

    const result = await tool.call(parsed.data, toolUseContext)
    return String(result.data)
  }

  private makeContext(): ToolUseContext {
    return {
      abortController: new AbortController(),
      messages: this.state.messages,
      getAppState: () => ({}),
      setAppState: () => {},
      options: {
        tools: this.tools,
        debug: false,
      },
    }
  }

  setListening(listening: boolean) {
    this.state.isListening = listening
    this.callbacks.onStateChange?.(this.state)
  }

  setSpeaking(speaking: boolean) {
    this.state.isSpeaking = speaking
    this.callbacks.onStateChange?.(this.state)
  }
}

export type OrchestratorOptions = {
  defaultAgent?: string
  callbacks?: OrchestratorCallbacks
}

export type OrchestratorCallbacks = {
  onStateChange?: (state: OrchestratorState) => void
  injectToActiveApp?: (text: string) => Promise<void>
}
```

---

## Phase 4: Voice Layer

### Task 9: OpenAI Realtime API Client

**Files:**
- Create: `src/voice/RealtimeClient.ts`
- Create: `src/voice/index.ts`

**Step 1: Write the Realtime client**

```typescript
// src/voice/RealtimeClient.ts
export type RealtimeCallbacks = {
  onAudioIn?: (audio: Uint8Array) => void
  onTranscript?: (text: string) => void
  onAudioOut?: (audio: Uint8Array) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
}

export class RealtimeClient {
  private ws: WebSocket | null = null
  private callbacks: RealtimeCallbacks
  private apiKey: string
  private model: string

  constructor(options: {
    apiKey: string
    model?: string
    callbacks: RealtimeCallbacks
  }) {
    this.apiKey = options.apiKey
    this.model = options.model ?? 'gpt-realtime-1.5'
    this.callbacks = options.callbacks
  }

  async connect(): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${this.model}`
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'realtime-v1',
      },
    })

    this.ws.onopen = () => {
      this.callbacks.onConnected?.()
      this.sendSessionConfig()
    }

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      this.handleMessage(data)
    }

    this.ws.onerror = (event) => {
      this.callbacks.onError?.(new Error(String(event)))
    }

    this.ws.onclose = () => {
      this.callbacks.onDisconnected?.()
    }
  }

  disconnect() {
    this.ws?.close()
    this.ws = null
  }

  sendAudio(audio: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Encode(audio),
    }))
  }

  private sendSessionConfig() {
    if (!this.ws) return
    this.ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad' },
        tools: [],  // tools added by orchestrator
      },
    }))
  }

  private handleMessage(data: Record<string, unknown>) {
    switch (data.type) {
      case 'session.created':
        // connected
        break
      case 'input_audio_buffer.speech_started':
        this.callbacks.onAudioIn?.(new Uint8Array())
        break
      case 'input_audio_buffer.speech_stopped':
        // user stopped speaking
        break
      case 'conversation.item.input_audio_transcription.completed':
        this.callbacks.onTranscript?.(String(data.transcript ?? ''))
        break
      case 'response.audio.delta':
        if (data.delta) {
          const audio = base64Decode(String(data.delta))
          this.callbacks.onAudioOut?.(audio)
        }
        break
      case 'response.done':
        // response complete
        break
    }
  }
}

function base64Encode(buffer: Uint8Array): string {
  return btoa(String.fromCharCode(...buffer))
}

function base64Decode(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
```

**Step 2: Write voice module index**

```typescript
// src/voice/index.ts
export { RealtimeClient, type RealtimeCallbacks } from './RealtimeClient.js'
```

---

## Phase 5: macOS App

### Task 10: macOS App Setup

**Files:**
- Create: `macos/Helper.xcodeproj/project.pbxproj` (Xcode project)
- Create: `macos/Helper/App.swift`
- Create: `macos/Helper/ContentView.swift`
- Create: `macos/Helper/AgentSidebar.swift`
- Create: `macos/Helper/ChatView.swift`
- Create: `macos/Helper/StatusBar.swift`
- Create: `macos/Helper/VoiceManager.swift`
- Create: `macos/Helper/HotwordDetector.swift`
- Create: `macos/Helper/NetworkMonitor.swift`
- Create: `macos/Helper/Info.plist`
- Create: `macos/Helper/Helper.entitlements`

**Step 1: Create project.yml for XcodeGen**

```yaml
# macos/project.yml
name: Helper
options:
  bundleIdPrefix: com.helper
  deploymentTarget:
    macOS: "14.0"
targets:
  Helper:
    type: application
    platform: macOS
    sources:
      - path: Helper
    settings:
      PRODUCT_BUNDLE_IDENTIFIER: com.helper.Agent
      INFOPLIST_FILE: Helper/Info.plist
      CODE_SIGN_ENTITLEMENTS: Helper/Helper.entitlements
      ENABLE_HARDENED_RUNTIME: YES
      COMBINE_HIDPI_IMAGES: YES
```

**Step 2: Write App.swift**

```swift
// macos/Helper/App.swift
import SwiftUI

@main
struct HelperApp: App {
  @StateObject private var appState = AppState()

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(appState)
    }
  }
}

class AppState: ObservableObject {
  @Published var isOnline = true
  @Published var isListening = false
  @Published var isSpeaking = false
  @Published var selectedAgent: Agent = Agent(id: "main", name: "Helper", type: "orchestrator")
  @Published var agents: [Agent] = [
    Agent(id: "main", name: "Helper", type: "orchestrator")
  ]
  @Published var messages: [ChatMessage] = []
  @Published var hotwordReady = true
}

struct Agent: Identifiable, Hashable {
  let id: String
  let name: String
  let type: String
}

struct ChatMessage: Identifiable {
  let id = UUID()
  let role: ChatRole
  let content: String
  let timestamp: Date

  enum ChatRole {
    case user
    case assistant
    case system
  }
}
```

**Step 3: Write ContentView (main layout)**

```swift
// macos/Helper/ContentView.swift
import SwiftUI

struct ContentView: View {
  @EnvironmentObject var appState: AppState

  var body: some View {
    HStack(spacing: 0) {
      AgentSidebar()
        .frame(width: 220)

      Divider()

      VStack(spacing: 0) {
        ChatView()

        Divider()

        InputBar()
      }
    }
    .frame(minWidth: 800, minHeight: 600)
  }
}
```

**Step 4: Write AgentSidebar**

```swift
// macos/Helper/AgentSidebar.swift
import SwiftUI

struct AgentSidebar: View {
  @EnvironmentObject var appState: AppState

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("AGENTS")
        .font(.caption)
        .fontWeight(.semibold)
        .foregroundColor(.secondary)
        .padding(.horizontal, 12)
        .padding(.top, 16)
        .padding(.bottom, 8)

      ForEach(appState.agents) { agent in
        AgentRow(agent: agent)
      }

      Spacer()

      Divider()
        .padding(.horizontal, 12)

      Button {
        // Add new agent
      } label: {
        Label("New Agent", systemImage: "plus")
          .font(.system(size: 13))
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .foregroundColor(.secondary)
      }
      .buttonStyle(.plain)
      .padding(12)
    }
    .background(Color(nsColor: .controlBackgroundColor))
  }
}

struct AgentRow: View {
  let agent: Agent
  @EnvironmentObject var appState: AppState

  var isSelected: Bool {
    appState.selectedAgent.id == agent.id
  }

  var body: some View {
    Button {
      appState.selectedAgent = agent
    } label: {
      HStack {
        Circle()
          .fill(agent.type == "orchestrator" ? Color.green : Color.blue)
          .frame(width: 8, height: 8)
        Text(agent.name)
          .font(.system(size: 13))
        Spacer()
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(isSelected ? Color.accentColor.opacity(0.15) : Color.clear)
      .cornerRadius(6)
    }
    .buttonStyle(.plain)
  }
}
```

**Step 5: Write ChatView**

```swift
// macos/Helper/ChatView.swift
import SwiftUI

struct ChatView: View {
  @EnvironmentObject var appState: AppState

  var body: some View {
    VStack {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(appState.messages) { message in
              MessageBubble(message: message)
                .id(message.id)
            }
          }
          .padding()
        }
        .onChange(of: appState.messages.count) { _, _ in
          withAnimation {
            proxy.scrollTo(appState.messages.last?.id)
          }
        }
      }

      StatusBar()
    }
  }
}

struct MessageBubble: View {
  let message: ChatMessage

  var body: some View {
    HStack {
      if message.role == .user { Spacer() }

      VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
        Text(message.content)
          .font(.system(size: 14))
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(message.role == .user ? Color.accentColor : Color(nsColor: .controlBackgroundColor))
          .foregroundColor(message.role == .user ? .white : .primary)
          .cornerRadius(12)

        Text(message.timestamp, style: .time)
          .font(.caption2)
          .foregroundColor(.secondary)
      }

      if message.role != .user { Spacer() }
    }
  }
}
```

**Step 6: Write InputBar**

```swift
// macos/Helper/InputBar.swift
import SwiftUI

struct InputBar: View {
  @EnvironmentObject var appState: AppState
  @State private var text = ""

  var body: some View {
    HStack(spacing: 8) {
      Button {
        appState.isListening.toggle()
      } label: {
        Image(systemName: appState.isListening ? "mic.fill" : "mic")
          .font(.system(size: 16))
          .foregroundColor(appState.isListening ? .red : .secondary)
      }
      .buttonStyle(.plain)

      TextField("Type a message...", text: $text)
        .textFieldStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor))
        .cornerRadius(8)
        .onSubmit {
          send()
        }

      Button {
        send()
      } label: {
        Image(systemName: "arrow.up.circle.fill")
          .font(.system(size: 22))
          .foregroundColor(text.isEmpty ? .secondary : .accentColor)
      }
      .buttonStyle(.plain)
      .disabled(text.isEmpty)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }

  private func send() {
    guard !text.isEmpty else { return }
    let content = text
    text = ""
    appState.messages.append(ChatMessage(role: .user, content: content, timestamp: Date()))
    // TODO: send to orchestrator
  }
}
```

**Step 7: Write StatusBar**

```swift
// macos/Helper/StatusBar.swift
import SwiftUI

struct StatusBar: View {
  @EnvironmentObject var appState: AppState

  var body: some View {
    HStack {
      Circle()
        .fill(appState.isOnline ? Color.green : Color.red)
        .frame(width: 8, height: 8)

      Text(appState.isOnline ? "Online" : "Offline")
        .font(.system(size: 11))
        .foregroundColor(.secondary)

      Spacer()

      if appState.hotwordReady {
        Text("\"Hey Agent\" ready")
          .font(.system(size: 11))
          .foregroundColor(.secondary)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(Color(nsColor: .windowBackgroundColor))
  }
}
```

**Step 8: Write VoiceManager, HotwordDetector, NetworkMonitor**

```swift
// macos/Helper/VoiceManager.swift
import Foundation
import AVFoundation

class VoiceManager: ObservableObject {
  @Published var isListening = false
  @Published var isSpeaking = false

  private var audioEngine: AVAudioEngine?
  private var RealtimeClient: RealtimeClient?

  func startListening() {
    // Capture microphone audio → send to RealtimeClient
    isListening = true
  }

  func stopListening() {
    audioEngine?.stop()
    isListening = false
  }
}
```

```swift
// macos/Helper/HotwordDetector.swift
import Foundation
import Speech
import SoundAnalysis

class HotwordDetector: ObservableObject {
  @Published var isListening = false

  private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
  private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
  private var recognitionTask: SFSpeechRecognitionTask?

  func start() {
    isListening = true
    // TODO: implement keyword spotting using SFSpeechRecognizer
    // or Apple Neural Engine for low-power wake word
  }

  func stop() {
    isListening = false
    recognitionTask?.cancel()
  }
}
```

```swift
// macos/Helper/NetworkMonitor.swift
import Foundation
import Network

class NetworkMonitor: ObservableObject {
  @Published var isConnected = true

  private let monitor = NWPathMonitor()

  init() {
    monitor.pathUpdateHandler = { [weak self] path in
      DispatchQueue.main.async {
        self?.isConnected = path.status == .satisfied
      }
    }
    monitor.start(queue: DispatchQueue(label: "NetworkMonitor"))
  }

  deinit {
    monitor.cancel()
  }
}
```

**Step 9: Write Info.plist and entitlements**

```xml
<!-- macos/Helper/Info.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleName</key><string>Helper</string>
  <key>NSMicrophoneUsageDescription</key><string>Helper needs microphone access for voice commands.</string>
  <key>NSAppleEventsUsageDescription</key><string>Helper needs accessibility access to inject text into other apps.</string>
  <key>LSUIElement</key><false/>
</dict>
</plist>
```

```xml
<!-- macos/Helper/Helper.entitlements -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key><false/>
  <key>com.apple.security.automation.apple-events</key><true/>
</dict>
</plist>
```

**Step 10: Generate Xcode project**

Run: `xcodegen generate` (from `macos/` directory)
Expected: `Helper.xcodeproj` created

---

## Phase 6: Integration & Wiring

### Task 11: Wire Everything Together

**Files:**
- Modify: `src/index.ts`
- Modify: `macos/Helper/App.swift` (add NetworkMonitor)

**Step 1: Wire orchestrator to voice layer in entry point**

```typescript
// src/index.ts
import { RealtimeClient } from './voice/index.js'
import { Orchestrator } from './agent/Orchestrator.js'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''

async function main() {
  console.log('Helper Agent starting...')

  const orchestrator = new Orchestrator({
    defaultAgent: 'main',
    callbacks: {
      onStateChange: (state) => {
        console.log('State:', JSON.stringify(state, null, 2))
      },
    },
  })

  // Wire voice layer
  const voiceClient = new RealtimeClient({
    apiKey: OPENAI_API_KEY,
    model: 'gpt-realtime-1.5',
    callbacks: {
      onTranscript: async (text) => {
        if (!text.trim()) return
        console.log('User said:', text)
        const response = await orchestrator.handleUserMessage(text)
        console.log('Agent:', response)
      },
      onConnected: () => console.log('Voice: connected'),
      onDisconnected: () => console.log('Voice: disconnected'),
      onError: (err) => console.error('Voice error:', err),
    },
  })

  await voiceClient.connect()
  console.log('Ready. Say "Hey Agent" or type a message.')
}

main().catch(console.error)
```

**Step 2: Wire network state in App.swift**

```swift
// In AppState, add:
@Published var networkMonitor = NetworkMonitor()

// On appear:
.onReceive(networkMonitor.$isConnected) { isOnline in
  appState.isOnline = isOnline
}
```

---

## Task 12: Build & Verify

**Step 1: Build TypeScript**

Run: `bun build src/index.ts --outdir dist --target node`
Expected: dist/index.js created

**Step 2: Open macOS project**

Run: `open macos/Helper.xcodeproj`
Expected: Xcode opens

**Step 3: Build macOS app**

In Xcode: Product → Build (⌘B)
Expected: Build succeeds

---

## Open Implementation Notes

- **Sub-agent spawning**: Use `child_process.spawn` in a separate task, communicate via stdout/JSON lines
- **Hotword**: Use `SFSpeechRecognizer` with a keyword table, or Porcupine for better accuracy
- **Input injection**: Use `CGEvent` to post keyboard events to the frontmost app
- **Mollotov MCP**: Wire `WebSearchTool` to Mollotov's local AI MCP port for free page queries
- **Voice model**: The orchestrator can call the Realtime API directly; the voice layer is just the audio transport
