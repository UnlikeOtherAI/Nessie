# Helper Agent

Personal voice-first AI agent for macOS with multi-agent orchestration.

## Architecture

- **Voice Layer** — OpenAI Realtime API (audio-in/audio-out WebSocket), single model
- **Orchestrator** — Main agent, coordinates all activity
- **Sub-Agents** — Spawned on demand, each with specific purpose
- **Tool Layer** — File read/write, bash, file search, web search

## Tech

- OpenAI Realtime API (`gpt-4o-realtime-preview`) for voice-to-voice
- macOS accessibility / input injection for keyboard mode
- Multi-agent orchestration with shared tool layer

## Docs

- [brief.md](docs/brief.md) — Full project brief
