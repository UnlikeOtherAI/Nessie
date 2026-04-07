# Gap Analysis: Helper Agent vs OpenClaw

> **Status**: historical gap-analysis note. Verify against [openclaw-reference.md](./openclaw-reference.md) and [functionality.md](./functionality.md) before using as implementation guidance.

> This document maps what the Helper Agent project already has against what OpenClaw provides, identifies integration paths, and recommends how to proceed.

## What Helper Agent Has

From `docs/brief.md` and `src/agent/Orchestrator.ts`:

| Capability | Implementation |
|---|---|
| **Voice input/output** | OpenAI Realtime API (`gpt-realtime-1.5`) — audio WebSocket, true voice-to-voice, single model |
| **Voice fallback** | Minimax TTS for output only |
| **Keyboard input** | macOS input injection via accessibility APIs — types into any text field |
| **Orchestration** | `Orchestrator` class — central coordinator, decides voice response vs inject vs sub-agent |
| **Sub-agents** | Spawned via `max` CLI (MiniMax API, Anthropic-compatible) |
| **Tool layer** | `Tool<Input, Output, Progress>` interface with `buildTool()` factory; built-in: Bash, FileRead, FileWrite, Glob, Grep, WebSearch |
| **Tool orchestration** | `runTools()` with read/write partitioning, permission hooks, abort support |
| **Session context** | In-memory conversation history + markdown workspace files |
| **macOS UI** | AppKit/SwiftUI native — sidebar agents, chat interface, voice toggle, status bar |
| **State management** | `OrchestratorState` with agents, messages, subAgents, isListening, isSpeaking |
| **Deployment** | Self-hosted, single machine |
| **HTTP API** | `src/index.ts` entry point |

## What OpenClaw Has

| Capability | Implementation |
|---|---|
| **Messaging channels** | WhatsApp, Telegram, Discord, Slack, Teams (plugin), Matrix, Nostr, Zalo, Voice Call |
| **Gateway WS protocol** | Typed RPC + events: `connect`, `chat.*`, `sessions.*`, `node.*` |
| **HTTP APIs** | OpenAI-compatible `/v1/chat/completions`, OpenResponses `/v1/responses`, `/tools/invoke`, `/sessions/{key}/history` |
| **Webhooks** | `/hooks/wake`, `/hooks/agent` |
| **Agent runtime** | Embedded Pi SDK — agent loop with tool streaming and session persistence |
| **Session model** | Keyed threads in JSONL (`agent:<id>:<channel>:group:<id>` etc.) |
| **Skills** | Instruction/tool bundles from ClawHub or local `skills/` directory |
| **Plugins** | Code modules registering tools, commands, RPC methods, HTTP handlers, background services |
| **Cron/scheduling** | Built-in scheduler with chat delivery |
| **Lobster workflows** | Typed multi-step pipelines with approval gates and resumable state |
| **Device nodes** | Paired mobile/desktop devices declaring capabilities via WS `node` role |
| **Push notifications** | APNs relay-backed (iOS); FCM planned (Android) |
| **Tool policy** | Per-agent allow/deny profiles; Docker sandboxing |
| **Multi-agent** | Built-in multi-agent routing with per-agent sandbox profiles |
| **Discovery** | Bonjour/mDNS/NSD for LAN; Tailscale for remote |
| **Security** | Device pairing, bootstrap tokens, tool policy, security audit CLI |

## Direct Comparison

| Dimension | Helper Agent | OpenClaw | Delta |
|---|---|---|---|
| **Voice layer** | OpenAI Realtime API (primary) | No native voice — relies on channel TTS/STT | Helper ahead |
| **Keyboard/text input** | Direct macOS injection (native) | Via channel messages | Helper ahead |
| **Chat UI** | Native macOS app | Control UI (web), TUI | Different target |
| **Messaging channels** | None | 10+ built-in + plugins | OpenClaw ahead |
| **Tool layer** | 5 tools (file, bash, search, find) | 20+ built-in + extensible via skills/plugins | OpenClaw ahead |
| **Sub-agent spawning** | Via `max` CLI (MiniMax) | Via Gateway + Pi runtime | Both have it |
| **Orchestration** | Custom `Orchestrator` class | Built-in multi-agent routing | Both have it |
| **Session persistence** | Markdown workspace files | JSONL transcripts + SQLite indexes | OpenClaw ahead |
| **WS protocol** | OpenAI Realtime (voice) | Gateway protocol (connect/chat.*/sessions.*) | Both have WS |
| **HTTP API** | Minimal (index.ts) | Full HTTP surface (OpenAI, OpenResponses, tools) | OpenClaw ahead |
| **Cron/scheduling** | None | Built-in | OpenClaw ahead |
| **Workflows with approvals** | None | Lobster | OpenClaw ahead |
| **macOS desktop node** | The app itself | Optional node app (Super Alpha) | Helper is the app |
| **Push notifications** | None (online detector only) | APNs relay-backed | OpenClaw ahead |
| **Tool policy/sandboxing** | None | Per-agent profiles + Docker | OpenClaw ahead |
| **Self-hosted** | Yes | Yes | Equal |
| **Mobile client** | None (out of scope) | Planned native (iOS/Android) | Both planning |

## Integration Paths

### Path A: Helper Agent as OpenClaw Operator Client

Helper Agent connects to OpenClaw's Gateway as an **operator** over the Gateway WS protocol, using its existing voice layer to handle audio and its orchestrator to manage sub-agents.

```
[User speaks] → Helper Agent (OpenAI Realtime)
                     ↓
              Orchestrator decides:
                     ├── Voice response → OpenClaw via chat.send
                     │                     (OpenClaw routes to Telegram/WhatsApp/etc.)
                     ├── Input inject → Helper types locally (no OpenClaw)
                     └── Spawn sub-agent → max CLI + OpenClaw session
```

**What Helper gains**: access to OpenClaw's messaging channels (Telegram, WhatsApp, etc.), OpenClaw's tool ecosystem (skills/plugins), OpenClaw's cron and Lobster workflows, OpenClaw's session persistence.

**What OpenClaw gains**: a native macOS voice input layer with low-latency audio, a native input injection engine.

**Implementation**:

1. Add a `OpenClawWSClient` class (see `docs/openclaw-reference.md` Part 2 for protocol reference).
2. Implement `connect.challenge` + `connect` handshake with device signing.
3. Map Helper's `chat.send` calls to OpenClaw's `chat.send` WS RPC.
4. Subscribe to `session.message` events to receive OpenClaw's streaming replies.
5. Route voice replies back through Helper's OpenAI Realtime output channel.
6. Keep Helper's tool layer intact; optionally expose OpenClaw tools via `POST /tools/invoke`.

**Effort**: Medium–High. Requires building the WS client, device signing, session routing, and voice-to-WS bridge.

### Path B: Helper Agent as OpenClaw Node

Helper Agent registers with an OpenClaw Gateway as a **node**, exposing its voice and input injection capabilities via `node.invoke`.

```
[Gateway] ← WS `node.invoke` commands
     ↓
[Helper Agent node] handles:
  - voice capture + streaming
  - macOS input injection
  - local tool execution (file, bash, etc.)
     ↓
[Gateway] receives results → routes to agent runtime + channels
```

**What Helper gains**: access to OpenClaw's messaging channels, multi-agent routing, cron, skills, and session management.

**What OpenClaw gains**: a voice-capable node with native macOS input injection.

**Implementation**:

1. Implement Gateway WS `connect` with `role: "node"`, declaring `caps` (voice, input_injection, file_tools), `commands`, and `permissions`.
2. Handle `node.invoke` requests: `voice.capture`, `inject.text`, `file.read`, `bash.run`, etc.
3. Stream responses back as `node.invoke` results.
4. Handle the node lifecycle (pairing approval, device token persistence, reconnection).

**Effort**: Medium. Less than Path A since Helper already has the capabilities — just needs to expose them over the Gateway protocol.

### Path C: Hybrid — OpenClaw as Helper's Backend

OpenClaw owns: messaging channels, cron, Lobster workflows, HTTP API surface, session persistence.
Helper Agent owns: voice layer, macOS input injection, local tool execution, sub-agent orchestration via MiniMax.

```
[Chat channel: Telegram/WhatsApp/...]
     ↓
[OpenClaw Gateway] receives message
     ↓
[OpenClaw agent loop] processes with Pi runtime
     ↓ (optionally)
[POST /tools/invoke] → Helper Agent executes tool (voice, input injection)
     ↓
[Result] → OpenClaw → channel response
```

Helper Agent acts as a **tool provider** for OpenClaw, registered via a skill or plugin. When OpenClaw needs voice input or input injection, it calls `POST /tools/invoke` pointing to Helper's HTTP server.

**Effort**: Medium. Requires an HTTP server in Helper Agent plus a skill/plugin in OpenClaw.

## Recommendations

**Short term (Path C — Hybrid)**: If the goal is to get OpenClaw's messaging channels working with Helper Agent's voice and input injection, the fastest path is adding an HTTP server to Helper Agent and a corresponding OpenClaw skill. This gives Helper Agent access to OpenClaw's channel ecosystem without rewriting either codebase.

**Medium term (Path B — Helper as OpenClaw Node)**: Once the hybrid works, expose Helper as a first-class OpenClaw node. This gives OpenClaw native macOS capabilities (voice, input injection) and gives Helper a cleaner integration model.

**Long term (Path A — Helper as OpenClaw Operator)**: Full integration where Helper Agent's Orchestrator uses OpenClaw as the messaging + automation backend. Helper's voice layer feeds into OpenClaw's `chat.send`; OpenClaw's session model replaces Helper's in-memory workspace. This is the most ambitious but also the most powerful.

## What Helper Agent Should NOT Take From OpenClaw

- **Skills marketplace (ClawHub)**: The supply chain risk is high (malicious skills, infostealers). If skills are needed, build a private registry or use local skill files reviewed by the user.
- **Full tool policy model**: OpenClaw's tool allow/deny profiles and Docker sandboxing are designed for multi-user/multi-tenant scenarios. Helper Agent is single-user on a trusted machine — these add complexity without value.
- **The Pi agent runtime**: Helper Agent already has an orchestrator + MiniMax sub-agents. Replacing it with Pi would be a rewrite for no clear benefit.
- **The Control UI**: Helper Agent already has a native macOS UI. No need to embed OpenClaw's web-based Control UI.

## What Helper Agent Should Take From OpenClaw

- **Session persistence model**: Replace in-memory + markdown with JSONL transcripts + structured metadata (timestamps, message roles, tool calls, usage). This enables search, pagination, and offline access.
- **Cron/scheduling**: Add a cron layer to trigger Helper Agent tasks on a schedule (e.g., "remind me at 9am").
- **Webhook triggers**: Accept inbound HTTP POSTs to trigger Helper Agent tasks (e.g., from Shortcuts, IFTTT, or other automations).
- **Multi-agent routing**: If the `max` CLI sub-agent model works well, formalise it with named agents, per-agent tool scopes, and a routing layer.
- **Lobster-style approvals**: For destructive or external side effects (sending emails, posting publicly), add an approval gate before executing.
