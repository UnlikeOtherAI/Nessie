# Helper — Personal Agent Brief

> **Status: historical architecture brief.** This document describes the original single-user personal voice agent concept. The project has since evolved into a **multi-tenant, self-hosted agentic work platform** (Organisation → Team → Project → Channel — a team being the SSO's team, see [standards/team-model.md](standards/team-model.md) — with RBAC, approvals, audit trail, token ledger, MCP connector management, triggers/scheduling, video calling, and human work distribution). For the current implementation state, see [functionality.md](./functionality.md).

> **Voice layer note:** The brief references both Minimax (in the voice mode section) and OpenAI Realtime API (in the architecture section) — this contradiction reflects the exploratory state of the original brief. The shipping codebase uses OpenAI Realtime API in the legacy macOS client only; voice is not implemented in the `api/` server stack.

## Current SSO identity invariant

For every deployment that uses UnlikeOtherAI (UOA) SSO, UOA is the sole
authority and durable store for human identity, authentication factors,
profiles, organisation and team membership, and invitations.

- Nessie must use the SSO API to read team directories and to create, resend,
  revoke, approve, decline, and accept invitations. Team matching is by the
  UOA subject and the UOA organisation/team identifiers returned by that API.
- Nessie must not create local-password accounts or persist duplicate UOA
  emails, display names, avatars, profiles, memberships, or invitation state.
  It may retain only the stable UOA subject/reference, genuinely
  product-specific extension data, and an encrypted scoped rotating UOA
  refresh token or opaque session handle when required as an OAuth relying
  party. That material is not a local credential or identity authority.
- UOA's organisation and team structure maps **1:1** into Nessie: one UOA
  organisation is one Nessie `Organization`, bound by the stable UOA
  organisation id (`Organization.externalOrgId`), and one UOA **team** is one
  **team** inside that organisation; Projects and Channels are Nessie's
  own and live inside a team
  ([standards/team-model.md](standards/team-model.md)). Flattening
  several UOA organisations into one local container — or keeping any second
  local copy of the org hierarchy — is the same violation as duplicating
  identity rows, and gets the same remedy: an API-backed refactor and a data
  migration, never a compatibility copy. A local install with no IdP keeps one
  unbound organisation (`externalOrgId` null). Model and migration:
  [plans/2026-08-15-uoa-org-tenancy.md](./plans/2026-08-15-uoa-org-tenancy.md).
- A bounded in-memory cache of SSO responses is permitted only as a
  non-authoritative performance cache; it must honour SSO revocation and
  freshness requirements.
- Any agent that finds a duplicate identity path, local membership authority,
  or proposed compatibility copy must flag it to the developer and plan an
  API-backed refactor and migration instead of extending the duplicate store.

## Vision

A personal AI agent that lives on your Mac, voice-first but keyboard-capable. You talk to it, it talks back. When you need deep research done across your computer, it spins up a sub-agent to do the work. When you're in keyboard mode, it types into whatever app you're using — no UI, no interruption, just you and the machine working together.

The feel: **Jarvis meets terminal**. Ambient, omnipresent, ready.

## Core Modes

### Voice Mode (Primary)
- You speak → audio streamed to **Minimax** in real-time
- Minimax responds with voice → played back to you immediately
- Low latency is critical — this must feel like a conversation, not a walkie-talkie
- Push-to-talk or always-listening (configurable)

### Keyboard Mode
- Agent types your spoken/written commands into the **currently active app**
- Uses macOS input injection — no clipboard hacking
- Works with any text field in any app
- Activated via hotkey or voice command

### Research Mode (Sub-agent)
- Triggered when you ask for something that needs deep investigation
- Spawns a **text-mode sub-agent** that can:
  - Read files on the filesystem
  - Search the web
  - Run terminal commands
  - Browse the codebase or documents
- Sub-agent reports back when done, then you can discuss findings via voice

## Architecture

```
[You] ←→ [Voice Layer (???)] ←→ [Orchestrator Agent] ←→ [Sub-Agents]
                                                      ↓
                                              [Tool Layer]
                                              - File read/write
                                              - Bash commands
                                              - File find
                                              - Web search
```

### Voice Layer
- Handles audio input/output only
- Streams voice to/from **OpenAI Realtime API** (`gpt-realtime-1.5`)
- True voice-to-voice: audio in → audio out (single model, WebSocket/WebRTC)
- Sub-250ms latency, streaming audio chunks
- No STT/TTS split — model handles speech understanding and generation natively
- Fallback: Minimax TTS for voice output if OpenAI voice quality is preferred

### Orchestrator Agent (Main Agent)
- **Central coordinator, always running**
- Receives text context from voice layer (after OpenAI Realtime transcribes)
- Decides what to do: respond vocally, inject to app, or spawn sub-agent
- **Spawns and manages all sub-agents** — can spin up multiple simultaneously
- **Owns the tool layer** — orchestrates which tools are available to which agents
- **Sub-agents run via `max`** — MiniMax-powered Claude (ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic, token=$MINIMAX_API_KEY)
- Maintains conversation context and memory across sessions
- Handles input injection coordination with active app detection
- Subscribes to audio state (listening, speaking, idle)

### Sub-Agents
- **Created and managed by orchestrator** — spawned on demand, killed when done
- Run via `max` CLI (MiniMax API, Anthropic-compatible)
- Can run multiple concurrently (pool or parallel)
- Each sub-agent gets tools + task context from orchestrator
- Report results back to orchestrator when complete
- Types: research, file-work, bash-work, search — or custom per task

### Tool Layer (Available to all agents)
The orchestrator manages tool access — assigns tools to sub-agents based on task needs.

#### Tool Interface
Inspired by Claude Code's tool architecture. Each tool implements a unified interface:

```typescript
interface Tool<Input, Output, Progress> {
  name: string
  inputSchema: ZodSchema<Input>
  call(args: Input, context: ToolUseContext): Promise<ToolResult<Output>>
  description(args: Input): Promise<string>
  isConcurrencySafe(input: Input): boolean   // can run in parallel with other tools
  isReadOnly(input: Input): boolean         // doesn't modify system state
  isDestructive?(input: Input): boolean      // irreversible operations
  renderToolResultMessage(output: Output): ReactNode
  renderToolUseMessage(input: Partial<Input>): ReactNode
}
```

Built with a `buildTool()` factory that supplies sensible defaults:
- `isEnabled` → true
- `isConcurrencySafe` → false (assume not safe by default)
- `isReadOnly` → false (assume writes)
- `isDestructive` → false
- `checkPermissions` → allow (defer to permission system)

#### ToolUseContext
Rich context passed to every tool call:
- `abortController` — cancellation support
- `getAppState() / setAppState()` — shared state
- `messages` — conversation history
- `options.tools` — available tools registry
- `options.mcpClients` — MCP server connections

#### Tool Orchestration
`runTools()` orchestrates tool execution:
1. Partition tools into batches: read-only tools run concurrently, write tools run serially
2. Execute each batch, yield progress messages and results
3. Run pre/post tool hooks (permission checks, logging)

#### Tool Execution Flow
```
runToolUse(toolUse, context)
  → validateInput()       // Zod schema validation
  → checkPermissions()    // permission system
  → runPreToolUseHooks()  // pre-execution hooks
  → tool.call()           // actual tool execution
  → runPostToolUseHooks() // post-execution hooks
  → renderToolResultMessage() // UI rendering
```

#### Core Tools
- **File read/write** — read and write files on filesystem
- **Bash** — execute shell commands
- **File find** — locate files by name/content on disk
- **Web search** — search internet for information

## Interaction Flow

```
[Voice in]
    → OpenAI Realtime API (audio WebSocket)
    → Orchestrator receives context + audio response
    → Orchestrator decides action:
        → [Voice response] → streamed back via Realtime API
        → [Inject to app] → finds active app, types text
        → [Spawn sub-agent] → assigns tools + task, sub-agent works
    → Orchestrator waits for sub-agent results
    → Synthesizes final response → voice out via Realtime API
```

## Native macOS App

### Layout
```
┌─────────────────────────────────────────────────────┐
│ [≡]  Helper                              [🎤] [⚙]  │  ← Title bar
├────────────┬────────────────────────────────────────┤
│            │                                        │
│  AGENTS    │          Chat Interface                │
│            │                                        │
│ ┌────────┐ │  ┌─────────────────────────────────┐  │
│ │Agent 1 │ │  │ Assistant message bubble        │  │
│ └────────┘ │  └─────────────────────────────────┘  │
│ ┌────────┐ │                                        │
│ │Agent 2 │ │  ┌─────────────────────────────────┐  │
│ └────────┘ │  │ User message bubble             │  │
│ ┌────────┐ │  └─────────────────────────────────┘  │
│ │Agent 3 │ │                                        │
│ └────────┘ │                                        │
│            │                                        │
│ ────────── │  ┌─────────────────────────────────┐  │
│ + New Agent│  │ Type a message...          [⏎] │  │
│            │  └─────────────────────────────────┘  │
├────────────┴────────────────────────────────────────┤
│ [🔴 Online / 🟢 Offline]   "Hey Agent" ready       │  ← Status bar
└─────────────────────────────────────────────────────┘
```

- **Left sidebar** — list of agents (user's personal agents + sub-agents)
- **Main chat** — conversation with selected agent
- **Text input** — bottom, with send button
- **Voice toggle** — activate speech mode in-app
- **Status bar** — online/offline indicator, hotword status

### Hotword Detection (Offline)
- Always-listening wake word processed **locally on-device** (no network)
- User configurable name (default: "Hey Agent")
- When detected:
  1. Local wake word triggers → app activates
  2. Voice mode starts automatically
  3. Audio streams to Minimax
  4. Minimax responds → played back to user
- Uses Apple Silicon ANE or equivalent for low-power wake word

### Voice Activation States
| State | Indicator | Behavior |
|-------|-----------|----------|
| Idle | Gray mic | Waiting for hotword or manual activate |
| Listening | Pulsing red | Hotword detected, capturing voice |
| Speaking | Animated wave | Minimax responding via voice |
| Offline | Red dot | No network — voice disabled, text only |

### Online / Offline Detector
- Monitors network connectivity continuously
- When offline:
  - Status bar shows red indicator
  - Voice mode disabled (requires Minimax API)
  - Text chat still functional
  - Sub-agents with local tools still work
- When online: green indicator, full functionality

## Key Capabilities

1. **Real-time voice-to-voice** via Minimax (voice layer only)
2. **Hotword detection** — "Hey Agent" wakes locally, no network required
3. **Input injection** — send text to any macOS text field
4. **Multi-agent orchestration** — spawn/manage multiple sub-agents
5. **Tool layer** — file, bash, search, find available to all agents
6. **Context awareness** — knows what's on screen / what app is active
7. **Offline detector** — network monitoring, graceful degradation
8. **Native macOS UI** — sidebar agents, chat interface, voice toggle

## Out of Scope (MVP)

- Mobile companion app
- Multi-user / shared devices
- Cloud sync of conversation history

## Open Questions

### Voice-to-Voice — RESOLVED
- **OpenAI Realtime API** (`gpt-4o-realtime-preview`) — true audio-in/audio-out via WebSocket, single model handles everything
- Latency: ~200-300ms end-to-end
- Must verify: pricing, rate limits, audio format support (PCM 24kHz)
- Fallback voice: Minimax TTS for output only if needed

### Other Open Questions
- Sub-agent communication — IPC socket, file-based, or stdout capture
- Tool schema format — Zod vs JSON Schema for tool input validation
- Progress reporting — streaming progress vs polling for long-running tools
- Hotword engine — Apple Speech framework, ANE, or Porcupine/brownie for local wake word?
