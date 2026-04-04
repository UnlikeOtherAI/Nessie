# Build: Personal AI Coworker App

## Goal

A lightweight macOS menu bar app — your own personal "AI Coworker" — built on top of the existing Helper Agent. It connects to your local Helper backend, shows your conversation threads, lets you chat via text or voice, and gives you a live view of what's running.

Think of it as the thin client that sits between you and the Helper Agent orchestrator, with a design inspired by the OpenClaw AI Coworker app but built for a single-user, single-machine context.

---

## What We Have Already

| Layer | Current state |
|---|---|
| **Voice layer** | `RealtimeClient.ts` — OpenAI Realtime WebSocket, audio in/out |
| **Orchestrator** | `Orchestrator.ts` — message routing, sub-agent spawning, scheduling |
| **Tool layer** | Bash, File, Glob, Grep, WebSearch |
| **Backend HTTP** | `src/index.ts` — HTTP server on port 4317, `/health`, `/state`, `/chat` |
| **macOS UI** | `App.swift` / `ContentView.swift` — sidebar + chat + input bar |
| **macOS ↔ backend** | `OrchestratorClient.swift` — REST client, polls state every 5s |
| **Input injection** | `InputBar.swift` — finds active text field, types into it |

---

## What to Build

### The app has 3 screens

```
┌─────────────────────────────────────────────────────────────┐
│ [≡]  Personal AI Coworker            [🎤] [⚙]  [●] Online  │  ← Title bar
├──────────────┬──────────────────────────────────────────────┤
│              │                                              │
│  THREADS     │  [Thread name]                               │
│              │                                              │
│  ─ Today     │  ┌────────────────────────────────────────┐  │
│  • Session A │  │ Assistant message bubble                 │  │
│  • Session B │  └────────────────────────────────────────┘  │
│              │                                              │
│  ─ Yesterday │  ┌────────────────────────────────────────┐  │
│  • Session C │  │ User message bubble                      │  │
│              │  └────────────────────────────────────────┘  │
│  ─ Agents    │                                              │
│  • Helper    │  ┌────────────────────────────────────────┐  │
│  • Coder     │  │ Type a message...                  [⏎] │  │
│  ─ Status    │  └────────────────────────────────────────┘  │
│  ● Speaking  │                                              │
├──────────────┴──────────────────────────────────────────────┤
│ [●] Helper running   Voice: Ready   3 active agents        │  ← Status bar
└─────────────────────────────────────────────────────────────┘
```

**Left sidebar** — threads grouped by day, agent list, live status indicators
**Main area** — chat thread with streaming responses
**Bottom bar** — text input + voice button + status
**Title bar** — app name, settings, connection status

### The 4 key things this app adds over the current UI

1. **Sessions / threads** — each conversation is a named thread, not just an agent
2. **Live streaming** — responses stream word-by-word, not just after completion
3. **Status panel** — see which agents are running, which tools fired, what the sub-agent is doing
4. **Voice mode** — push-to-talk, with visual feedback (waveform, listening indicator)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    macOS App (SwiftUI)                      │
│                                                              │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────┐  │
│  │  Sidebar     │  │  ChatView      │  │  StatusPanel   │  │
│  │  (threads,   │  │  (messages,    │  │  (agents,      │  │
│  │   agents)    │  │   streaming)   │  │   tools)       │  │
│  └──────┬───────┘  └───────┬────────┘  └───────┬────────┘  │
│         │                  │                   │           │
│  ┌──────┴──────────────────┴───────────────────┴───────┐   │
│  │              AppState (ObservableObject)              │   │
│  │  sessions, messages, agents, isListening, isSpeaking  │   │
│  └──────────────────────┬───────────────────────────────┘   │
│                         │                                   │
│  ┌──────────────────────┴───────────────────────────────┐   │
│  │           HelperClient (URLSession, WebSocket)         │   │
│  │  - REST: /chat, /state, /health                     │   │
│  │  - WS: /ws (for streaming responses + events)         │   │
│  └──────────────────────┬───────────────────────────────┘   │
└─────────────────────────┼─────────────────────────────────────┘
                          │ HTTP / WS
┌─────────────────────────┼─────────────────────────────────────┐
│                         ▼                                     │
│  ┌─────────────────────────────────────────────────────┐     │
│  │         Helper Backend (Node.js, src/index.ts)       │     │
│  │                                                     │     │
│  │  HTTP Server (port 4317)                            │     │
│  │  ├── GET  /health  → is backend alive               │     │
│  │  ├── GET  /state   → full orchestrator state        │     │
│  │  ├── POST /chat    → handle message, stream reply   │     │
│  │  └── WS   /ws     → event stream (sub-agent, tool) │     │
│  │                                                     │     │
│  │  Orchestrator (src/agent/Orchestrator.ts)           │     │
│  │  ├── Handles messages                               │     │
│  │  ├── Spawns sub-agents via `max` CLI               │     │
│  │  └── Manages schedules                              │     │
│  │                                                     │     │
│  │  Voice Layer (src/voice/RealtimeClient.ts)          │     │
│  │  └── OpenAI Realtime WebSocket (audio in/out)       │     │
│  └─────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

---

## Backend Changes

### Add WebSocket endpoint (`/ws`)

The macOS app needs real-time events, not polling. Add a WebSocket upgrade to the HTTP server:

```typescript
// src/index.ts additions

import { WebSocketServer, WebSocket } from 'ws'

// Collectors: apps that have opened a WS connection
const wsClients = new Set<WebSocket>()

// Emit an event to all connected apps
function broadcast(event: object) {
  const payload = JSON.stringify(event)
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload)
    }
  }
}

// Expose broadcast to orchestrator
function exposeBroadcast() {
  return broadcast
}

// In main():
// After server.listen():
const wss = new WebSocketServer({ server })
wss.on('connection', (ws) => {
  wsClients.add(ws)
  ws.on('close', () => wsClients.delete(ws))
  // Send current state on connect
  ws.send(JSON.stringify({ type: 'state', data: orchestrator.getState() }))
})
```

### Wire orchestrator → WS clients

Pass `exposeBroadcast` into the orchestrator, then call it from:

- `handleSubAgentTask` — emit `{ type: 'subagent.started', task }`
- Sub-agent completion — emit `{ type: 'subagent.done', result }`
- Tool execution — emit `{ type: 'tool.called', name, input }`
- Tool completion — emit `{ type: 'tool.done', output }`
- `sendMessage` → emit streaming deltas
- `appendAssistantReply` → emit `{ type: 'message', role, content, threadId }`
- Schedule triggers — emit `{ type: 'agent.wake', agentId, reason }`

### Enhance `/chat` with streaming

Make `POST /chat` return a streaming response so the app can render messages as they arrive:

```
POST /chat { "message": "...", "threadId": "..." }

Response (text/event-stream):
event: start
data: {"runId":"..."}

event: delta
data: {"content":"Hello"}

event: delta
data: {"content":"Hello world"}

event: done
data: {"content":"Hello world! How can I help?"}
```

Use `Transfer-Encoding: chunked` with `Content-Type: text/event-stream`.

---

## macOS App Changes

### New screens

| Screen | File | Description |
|---|---|---|
| Sessions sidebar | `SessionsSidebar.swift` | Thread list grouped by date, agent list |
| Chat view (enhanced) | `ChatView.swift` | Streaming messages, typing indicator |
| Status panel | `StatusPanel.swift` | Agent activity, tool calls, sub-agent progress |
| Voice mode overlay | `VoiceModeView.swift` | Waveform, listening/speaking state |
| Settings | `SettingsView.swift` | Backend URL, voice settings, agent management |

### AppState changes

```swift
@MainActor
class AppState: ObservableObject {
  // Existing
  @Published var isOnline = true
  @Published var isListening = false
  @Published var isSpeaking = false
  @Published var isThinking = false
  @Published var agents: [Agent] = []
  @Published var selectedAgent: Agent = ...
  @Published private(set) var allMessages: [ChatMessage] = []

  // New
  @Published var sessions: [Session] = []      // named conversation threads
  @Published var selectedSession: Session?      // currently viewed thread
  @Published var streamingContent: String = "" // partial response being rendered
  @Published var activeSubAgents: [SubAgent] = [] // currently running sub-agents
  @Published var recentToolCalls: [ToolCall] = [] // last N tool invocations

  // WS client
  private var webSocketTask: URLSessionWebSocketTask?

  func connectWebSocket()
  func disconnectWebSocket()
}
```

### HelperClient additions

```swift
final class HelperClient {
  // Existing: send(message:), fetchState()

  // New: WebSocket streaming
  func stream(message: String, threadId: String) -> AsyncStream<ChatEvent>
  func connectWebSocket() async throws -> AsyncStream<ServerEvent>
}

// Server → Client events over WS
enum ServerEvent {
  case state(OrchestratorStateResponse)
  case message(ChatMessage)
  case subAgentStarted(SubAgent)
  case subAgentDone(subAgentId: String, result: String)
  case toolCalled(name: String, input: String)
  case toolDone(name: String, output: String)
  case agentWake(agentId: String, reason: String)
  case streamingDelta(content: String)
  case streamingDone(content: String)
}

// Client → Server over WS (optional, for acknowledgements)
enum ClientEvent {
  case subscribe(sessionId: String)
  case unsubscribe(sessionId: String)
  case cancelSubAgent(subAgentId: String)
}
```

### Session model

```swift
struct Session: Identifiable, Codable {
  let id: String        // UUID
  let name: String      // "Conversation with Helper", "Research: OpenClaw"
  let threadId: String  // maps to orchestrator threadId
  let createdAt: Date
  let updatedAt: Date
  let messageCount: Int
  let preview: String   // last message snippet
  let agentId: String   // which agent owns this thread
}
```

### Voice mode UI

When the mic button is pressed:

1. Show `VoiceModeView` as an overlay (full-width waveform animation)
2. Connect to `RealtimeClient` (already in `src/voice/`)
3. Show real-time transcription as user speaks
4. Show streaming response as it arrives
5. Play audio output from OpenAI Realtime
6. Dismiss overlay on conversation end

The `RealtimeClient` lives in the **backend** (Node.js), not the macOS app. The macOS app sends audio to the backend over HTTP, and the backend streams to OpenAI Realtime and relays audio back. Alternatively, port `RealtimeClient` to Swift using `AVAudioEngine` + `URLSessionWebSocketTask`.

---

## UI/UX Details

### Sidebar layout

```
┌─────────────────┐
│ SESSIONS        │  ← section header
│ ─ Today (2)     │  ← collapsible group
│   ○ Research…   │  ← session rows with preview
│   ○ Quick q…    │
│ ─ Yesterday (1)  │
│   ○ OpenClaw…   │
│                 │
│ AGENTS          │  ← section header
│ ● Helper        │  ← green = active
│ ○ Coder         │  ← gray = idle
│ ○ Weather       │
│                 │
│ STATUS          │  ← section header
│ 🎙 Listening     │  ← live state
│ 🗣 Speaking      │
│ ⏳ Thinking      │
└─────────────────┘
```

### Message bubble improvements

- **User messages**: right-aligned, accent color fill
- **Assistant messages**: left-aligned, subtle background
- **Streaming**: assistant messages render incrementally as `streamingContent` updates
- **Tool calls**: inline expandable cards within assistant messages showing tool name + input
- **Sub-agent**: nested message showing sub-agent name, task, status badge
- **System messages**: centered, small, muted (e.g., "Coder agent created")

### Voice mode overlay

```
┌─────────────────────────────────────────────┐
│                                             │
│            ▓▓▓▓▓▓▓▓▓▓▓▓▓                   │
│          ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                 │  ← waveform animation
│         ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                │
│                                             │
│     "What are my top 3 tasks today?"        │  ← live transcription
│                                             │
│     I'm looking that up for you…             │  ← response streaming
│                                             │
│                  [🗣 Stop]                   │  ← stop button
└─────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1 — Backend WebSocket (`src/index.ts`)

1. Add `ws` package: `pnpm add ws`
2. Add WebSocket server attached to the HTTP server
3. Add `broadcast()` function
4. Wire orchestrator callbacks to call `broadcast()`
5. Make `POST /chat` return SSE streaming
6. Test with a simple JS client

### Phase 2 — macOS WS client (`OrchestratorClient.swift`)

1. Add `stream(message:threadId:)` returning `AsyncStream<ChatEvent>`
2. Add `connectWebSocket()` returning `AsyncStream<ServerEvent>`
3. Replace state polling (every 5s) with WS state updates
4. Remove the polling `Task` from `AppState`

### Phase 3 — Sessions model (`Models.swift` + `SessionsSidebar.swift`)

1. Add `Session` struct
2. Add `SubAgent` and `ToolCall` structs
3. Rewrite `SessionsSidebar` from `AgentSidebar`
4. Add session creation on first message
5. Add session grouping by date

### Phase 4 — Streaming chat (`ChatView.swift`)

1. Add `streamingContent` to AppState
2. Update `MessageBubble` to handle partial content
3. Add typing indicator when `isThinking`
4. Add inline tool call cards

### Phase 5 — Status panel (`StatusPanel.swift`)

1. Show active sub-agents with progress
2. Show recent tool calls (last 5)
3. Show agent wake events
4. Collapsible panel, toggled from sidebar

### Phase 6 — Voice mode (`VoiceModeView.swift` + bridge)

Two options:

**Option A — Bridge to backend RealtimeClient** (faster):
- macOS captures audio → sends to `POST /voice` on backend
- Backend streams to OpenAI Realtime → relays audio back
- macOS plays received audio chunks

**Option B — Port RealtimeClient to Swift** (lower latency):
- Port `src/voice/RealtimeClient.ts` to Swift using `URLSessionWebSocketTask`
- Use `AVAudioEngine` for capture/playback
- Reuse the same OpenAI Realtime session config

Start with Option A, move to Option B if latency is unacceptable.

---

## Not in scope

- Mobile companion app (iOS/Android) — future work
- OpenClaw Gateway integration — see `docs/openclaw-gap-analysis.md` for the plan
- Multiple users / shared devices
- Cloud sync
- Plugin ecosystem

---

## File map (after build)

```
macos/Helper/
├── App.swift                  ← unchanged (AppState + AppDelegate)
├── ContentView.swift          ← replace with SessionsSidebar + ChatView layout
├── Models.swift               ← add Session, SubAgent, ToolCall
├── SessionsSidebar.swift       ← new: thread list, agent list, status
├── ChatView.swift              ← rewrite: streaming messages
├── StatusPanel.swift           ← new: agent activity, tool calls
├── InputBar.swift             ← keep: text input (add voice button integration)
├── VoiceModeView.swift        ← new: voice overlay with waveform
├── VoiceManager.swift          ← rewrite: AVAudioEngine capture + playback
├── HelperClient.swift          ← rename from OrchestratorClient.swift, add WS
├── NetworkMonitor.swift        ← unchanged
├── HotwordDetector.swift      ← unchanged
└── SettingsView.swift         ← new: preferences

src/
├── index.ts                   ← add WebSocket server, SSE /chat, broadcast()
├── agent/Orchestrator.ts      ← add broadcast callback wiring
└── voice/RealtimeClient.ts    ← unchanged
```

---

## Testing

- Backend WS: connect with `wscat` or a simple Node WS client
- SSE streaming: `curl -N -X POST http://127.0.0.1:4317/chat -d '{"message":"hi"}'`
- macOS app: run in Xcode, send messages, verify streaming and status updates
- Voice mode: press mic, speak, verify transcription and audio playback
