# Nessie: CLI vs. macOS App — Functionality Audit

> **Status**: snapshot report as of 2026-04-07.

**Date**: 2026-04-07
**Purpose**: Determine whether the macOS app contains only interface code, or if any core functionality has been incorrectly placed there. Identify what belongs where.

---

## TL;DR

The macOS app is **almost entirely a thin interface/client**. All core functionality lives in the TypeScript CLI/server (`src/`). The app's only non-UI code is:

1. HTTP/SSE/WebSocket networking to the local server
2. AVAudioEngine audio capture for voice mode (partially stubbed — see Voice section)
3. Network connectivity monitoring
4. Client-side state management and event routing

No LLM calls, no tool execution, no task management, no orchestration, no persistence — none of that is in the app.

**Corrections from peer review** (incorporated below):
- MCP tool count is **31**, not 36.
- VoiceBridge audio streaming is **not implemented** — `sendAudioLevelToBackend` is a no-op stub; no actual audio data flows to the server.
- OpenClaw event translator (`event-translator.ts`) is **wired but never called** in the live event pipeline; `announce-converter.ts` is **dead code**.
- The `remote/` Go service is **not covered** in this report.
- `src/events.ts`, `src/orchestration/task-types.ts`, and `src/tools/types.ts` were initially undocumented — now added.

---

## What Lives in the CLI/Server (`src/`)

The TypeScript backend is the entire brain. It runs as a local Node.js process on `127.0.0.1:4317`.

### Core Engine

| File | Responsibility |
|---|---|
| `src/agent/Orchestrator.ts` | Central coordinator — message routing, agent spawning, action decisioning, conversation compression |
| `src/agent/types.ts` | Domain types for agents, messages, tasks |

### LLM Integration

| File | Responsibility |
|---|---|
| `src/llm/client.ts` | Non-streaming chat (OpenAI / MiniMax factory) |
| `src/llm/streaming.ts` | Streaming LLM responses (SSE parsing) |

### Tool Execution

| File | Responsibility |
|---|---|
| `src/tools/BashTool.ts` | Shell command execution |
| `src/tools/FileReadTool.ts` | File system read |
| `src/tools/FileWriteTool.ts` | File system write |
| `src/tools/GlobTool.ts` | Glob pattern file finding |
| `src/tools/GrepTool.ts` | Pattern search in files |
| `src/tools/WebSearchTool.ts` | Web search (stub) |
| `src/tools/Tool.ts` | Tool interface + factory |
| `src/tools/types.ts` | Tool runtime types: `ToolUseContext` (abort controller, messages, app state, tools), `ToolResult<T>`, `ToolUseBlock` |
| `src/tools/index.ts` | Barrel export — re-exports `allTools` array and all named tool instances |

### Orchestration / Task System

| File | Responsibility |
|---|---|
| `src/orchestration/task-types.ts` | Core type definitions: `TaskStatus` (8 states), `TaskRole` (6 roles: orchestrator/builder/reviewer/watcher/researcher/debugger), `Task`/`TaskEvent`/`TaskArtifact` interfaces, Zod schemas, `VALID_TRANSITIONS` map |
| `src/orchestration/task-ledger.ts` | SQLite-backed task lifecycle management |
| `src/orchestration/spawn-manager.ts` | Spawn queue, concurrency/depth limits, timeouts |
| `src/orchestration/role-registry.ts` | Role policies (allowed tools, spawn/mutate/review flags) |
| `src/orchestration/verification.ts` | Review gates, repair escalation |
| `src/orchestration/approvals.ts` | Human approval workflow |
| `src/orchestration/validators.ts` | External validators (ESLint, TSC, tests) |
| `src/orchestration/metrics.ts` | Per-task and aggregate metrics |
| `src/orchestration/watcher.ts` | Health checks (stale tasks, loops, runaway spawns) |

### Voice Layer

| File | Responsibility |
|---|---|
| `src/voice/RealtimeClient.ts` | OpenAI Realtime API WebSocket client — connects to `api.openai.com`; receives transcription via `onTranscript` callback. **Note:** `sendAudio()` is defined but not wired to any caller; responses do not flow to connected clients. |
| `src/voice/index.ts` | Barrel export — re-exports `RealtimeClient` and `RealtimeCallbacks` |
| `src/events.ts` | Shared `ServerEvent` type system (22 event variants) — the contract between server broadcast bus and all connected clients (SSE, WebSocket) |

### Persistence

| File | Responsibility |
|---|---|
| `src/db/database.ts` | SQLite schema + all CRUD (messages, diary, tasks, reviews, approvals) |

### MCP Server

| File | Responsibility |
|---|---|
| `src/mcp/server.ts` | MCP JSON-RPC 2.0 server — **31 tools** exposed (not 36), 3 resources (`helper://state`, `helper://sessions`, `helper://agents`) |
| `src/mcp/adapter.ts` | Bridges Orchestrator to MCP interface |

> **Peer review finding:** The report originally claimed 36 tools. The `TOOLS` array in `server.ts` contains exactly 31 named tools. The overcount of 5 has been corrected.

### HTTP/WebSocket Server

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point: HTTP server, WebSocket broadcast bus, Bonjour/mDNS, voice WS, MCP endpoint, all routes |

### Interoperability

| File | Responsibility | Status |
|---|---|---|
| `src/openclaw/session-mapper.ts` | Nessie ↔ OpenClaw session key mapping | **Live** — called by MCP tools |
| `src/openclaw/role-agent-adapter.ts` | Role policy → OpenClaw agent config | **Live** — called by `getOpenClawAgentConfigs` MCP tool |
| `src/openclaw/index.ts` | Barrel export — re-exports all four openclaw modules |
| `src/openclaw/event-translator.ts` | ServerEvent → OpenClaw Gateway translation (11 of 22 event types) | **Wired but disconnected** — `translateEvent()` is called by `translateEventToOpenClaw()` on the Orchestrator (line 899), but `translateEventToOpenClaw()` itself is never called anywhere in the codebase; the live SSE/WS pipeline never triggers it |
| `src/openclaw/announce-converter.ts` | Announce payload format conversion | **Dead code** — exported from barrel but never imported or called anywhere |

> **Peer review finding:** OpenClaw interop is available via 4 MCP tools for on-demand state queries, but the live event broadcast pipeline never routes through the event translator. The translation layer is architecturally present but functionally inactive. `toOpenClawAnnounce()` is entirely unused.

### Engine

| File | Responsibility |
|---|---|
| `src/engine/compression.ts` | LLM-based conversation summarization (diary entries) |

---

## What Lives in the macOS App

### Pure Business Logic (non-UI)

| File | Responsibility | Moves to CLI? |
|---|---|---|
| `NessieClient.swift` | HTTP REST (`/state`, `/chat/sync`, `/history`), SSE streaming (`/chat`), WebSocket broadcast client, event parsing | No — this IS the app's job as the interface to the server |
| `App.swift` (`AppState`) | Client-side state machine: event routing, session/message/task state hydration from server, SSE stream orchestration, send/delete dispatch | No — reasonable for a client to hold its own reactive state |
| `VoiceModeView.swift` (`VoiceBridge`) | AVAudioEngine capture (running locally), waveform RMS computation, WebSocket connection to `/voice`; receives transcription/response deltas | No — audio capture must be in the app (macOS hardware). **Note:** `sendAudioLevelToBackend()` is a stub — it stores `pendingLevel` locally but never sends it; no actual audio bytes flow to the server |
| `NetworkMonitor.swift` | `NWPathMonitor` for local connectivity tracking | No — purely app-level concern |
| `HotwordDetector.swift` | Stub (keyword spotting not implemented) | N/A — stub |
| `VoiceManager.swift` | Stub (only sets `isListening` flag) | N/A — stub |

### Pure UI

| File | Responsibility |
|---|---|
| `ContentView.swift` | Root 3-panel layout |
| `ChatView.swift` | Message bubbles, streaming indicator, toolbar |
| `SessionsSidebar.swift` | Session list grouped by date, agent list |
| `InputBar.swift` | Text input, send button, voice toggle |
| `StatusPanel.swift` | Tasks, validators, tool calls, alerts, agents, voice state |
| `StatusBar.swift` | Online/offline indicator |
| `VoiceModeView.swift` (`VoiceModeView` + `WaveformView`) | Voice overlay modal with waveform visualization |
| `Models.swift` | Data models — all pure data, no logic |

### Infrastructure

| File | Responsibility |
|---|---|
| `macos/project.yml` | XcodeGen configuration |
| `macos/Nessie.entitlements` | Sandbox + network entitlements |

---

## Assessment: Correctness of Current Separation

**Verdict: The separation is correct.**

### What belongs in the app (correctly placed)

- **Networking client** (`NessieClient.swift`) — The app's job is to connect to the local server and render what it receives.
- **Audio capture** (`VoiceBridge`) — `AVAudioEngine` must run in the app process on macOS hardware. The server cannot capture the Mac's microphone remotely.
- **Client state** (`AppState`) — Holding reactive UI state locally is normal for any client.
- **All UI views** — Obviously belongs in the app.

### What belongs in the server (correctly placed)

- **LLM orchestration** — The `Orchestrator` class calls the LLM API directly. The app has no API keys.
- **Tool execution** — `BashTool`, `FileReadTool`, etc. execute on the machine; the app is a thin renderer.
- **Task/approval/validator system** — The entire `orchestration/` directory. The app only displays the state.
- **MCP server** — 31 tools exposed via JSON-RPC (originally reported as 36 — corrected). The app doesn't implement any.
- **SQLite persistence** — All data lives in `~/.helper/agent.db`.
- **Voice AI** — `RealtimeClient` connects to OpenAI Realtime API. The app only captures raw audio.
- **Bonjour/mDNS** — Server advertises itself; app discovers it.

### What COULD be moved (if desired)

1. **`HotwordDetector.swift`** — Currently a stub. When implemented, it will use `Speech` framework (on-device keyword spotting). This correctly belongs in the app. No change needed.

2. **`VoiceManager.swift`** — Currently a stub wrapping `VoiceBridge`. This is a facade that could be removed, or kept as the public API once the stub is implemented.

3. **`NetworkMonitor.swift`** — Could be replaced by the app simply listening to the WebSocket disconnect events from the server. The server already sends `error` events. However, having a separate `NWPathMonitor` gives faster detection of network changes without waiting for a WS ping timeout. Not worth moving.

### What should NEVER be moved to the app

- **LLM calls** — App has no API keys and should not have them.
- **Tool execution** — Security risk; tools run shell commands.
- **Task state** — The SQLite-backed task ledger must stay server-side.
- **MCP server** — The MCP tools run commands on the machine; the app is not the right place.
- **Conversation compression** — Runs LLM summarization; requires API key.

---

## Summary Table

| Concern | Location | Correct? |
|---|---|---|
| UI rendering | macOS app | ✅ |
| HTTP/SSE/WS client networking | macOS app | ✅ |
| Audio capture | macOS app | ✅ |
| Client-side reactive state | macOS app | ✅ |
| Network connectivity monitor | macOS app | ✅ |
| LLM orchestration | CLI/server | ✅ |
| Tool execution | CLI/server | ✅ |
| Task/approval/validator system | CLI/server | ✅ |
| MCP server (31 tools) | CLI/server | ✅ |
| SQLite persistence | CLI/server | ✅ |
| OpenAI Realtime voice | CLI/server | ✅ (partially — RealtimeClient exists but is disconnected; `/voice` WS handles text only; app audio streaming is stubbed) |
| Bonjour/mDNS discovery | CLI/server | ✅ |
| Conversation compression | CLI/server | ✅ |
| OpenClaw interoperability | CLI/server | ✅ |

---

## Scope Limitation

This report covers the TypeScript CLI (`src/`) and the macOS app (`macos/Nessie/`). The project also contains a separate **Go service** at `remote/` — a zero-trust remote access control plane (Postgres, Redis, coturn, SSO) — which is outside the scope of this audit.

---

## Conclusion

The architecture is broadly correct and cleanly separated:

- **Server (`src/`)** = all intelligence, all action, all persistence — runs headless
- **App (`macos/`)** = interface + thin client for networking/audio/local state — renders and inputs only

No core functionality is misplaced. The app has no business logic that belongs in the server, and the server has no UI concerns. Moving anything meaningful from the server to the app would require giving the app API keys and tool execution access, which is a security and architectural regression.

The stubs (`HotwordDetector`, `VoiceManager`) are placeholders for features that correctly belong in the app.

### Corrections from peer review

| Issue | Severity | Detail |
|---|---|---|
| MCP tool count was 36, not 31 | Minor math error | Corrected to 31 |
| VoiceBridge audio streaming claimed but not implemented | Medium | `sendAudioLevelToBackend()` stores `pendingLevel` but never sends it; no PCM audio flows to the server; the `/voice` WS path handles text, not audio |
| OpenClaw event translator is wired but never called | Medium | `translateEventToOpenClaw()` on Orchestrator (line 899) is never called anywhere; the live SSE/WS broadcast never routes through the translation layer |
| OpenClaw `announce-converter.ts` is dead code | Low | `toOpenClawAnnounce()` is never imported or called anywhere |
| `src/events.ts` was initially undocumented | High | Now added — core event type system (22 variants) shared by all broadcast clients |
| `src/orchestration/task-types.ts` was initially undocumented | Medium | Now added — defines the full task state machine vocabulary |
| `src/tools/types.ts` was initially undocumented | Low | Now added — defines `ToolUseContext`, the runtime interface for tool execution |
| AppReveal MCP server runs inside the app (DEBUG only) | Low | `AppReveal.start()` in `AppDelegate` launches a third-party MCP server inside the app process in DEBUG builds only — a testing tool, not production code |
| 3 barrel `index.ts` files initially undocumented | Negligible | `src/tools/index.ts`, `src/voice/index.ts`, `src/openclaw/index.ts` — now added |
