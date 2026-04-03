# Helper Agent

Personal voice-first AI agent for macOS with multi-agent orchestration.

## Architecture

- **Voice Layer** — Minimax voice-to-voice API, audio passthrough
- **Orchestrator** — Main agent, coordinates all activity
- **Sub-Agents** — Spawned on demand, each with specific purpose
- **Tool Layer** — File read/write, bash, file search, web search

## Tech

- Minimax voice-to-voice API for real-time voice responses
- macOS accessibility / input injection for keyboard mode
- Multi-agent orchestration with shared tool layer

## Docs

- [brief.md](docs/brief.md) — Full project brief
