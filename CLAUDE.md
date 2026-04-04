# Helper Agent

Personal voice-first AI agent for macOS with multi-agent orchestration.

## Architecture

- **Voice Layer** — OpenAI Realtime API (`gpt-realtime-1.5`, audio-in/audio-out WebSocket), single model
- **Orchestrator** — Main agent, coordinates all activity
- **Sub-Agents** — Spawned on demand, each with specific purpose
- **Tool Layer** — File read/write, bash, file search, web search

## Tech

- OpenAI Realtime API (`gpt-4o-realtime-preview`) for voice-to-voice
- macOS accessibility / input injection for keyboard mode
- Multi-agent orchestration with shared tool layer
- MCP server — all app actions exposed as MCP tools (see `src/mcp/`)
- MDNS/Bonjour — backend advertises `_helper._tcp` for local network discovery

## Linting

- **TypeScript**: strict mode (`strict: true` in tsconfig), ESLint with `max-len`, `noImplicitAny`, `noUnusedLocals`
- **Swift**: SwiftLint with strict mode, warning treated as error in CI

## MCP Integration

All user-facing actions are MCP tools. The backend exposes an MCP server endpoint (`GET /mcp`, `POST /mcp`) that conforms to the Model Context Protocol spec. Any MCP client (Claude Code, etc.) can connect and invoke:

- `send_message` — push a chat message and stream the response
- `list_sessions` — return all conversation threads
- `get_state` — return current agent/sub-agent/tool state
- `invoke_tool` — call a named tool (Bash, FileRead, etc.)
- `voice_start` / `voice_stop` — start/stop voice session
- `stream_audio` — stream PCM audio for voice mode

## MDNS

The backend registers `_helper._tcp` on port 4317 via Bonjour/mDNS on launch. Clients on the same network discover it automatically without hardcoded IPs.

## Docs

- [brief.md](docs/brief.md) — Full project brief
- [build-ai-coworker.md](docs/build-ai-coworker.md) — macOS app build plan
