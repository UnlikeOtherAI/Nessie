<p align="center">
  <img src="assets/icon-trimmed.png" width="128" height="128" alt="Nessie icon">
</p>

<h1 align="center">Nessie</h1>

<p align="center">
  Voice-first personal AI agent for macOS.<br>
  Local orchestrator, macOS app, MCP surface, and an early remote control-plane scaffold.
</p>

<p align="center">
  <a href="docs/brief.md">Product Brief</a> &middot;
  <a href="docs/build-ai-coworker.md">Build Plan</a> &middot;
  <a href="docs/remote/brief.md">Remote Brief</a> &middot;
  <a href="docs/review-findings.md">Validated Findings</a>
</p>

---

## What it is

Nessie is a local-first assistant project built around a TypeScript orchestrator and a native macOS app. The intended interaction model is simple: talk to it, type to it, or let it spawn a focused sub-agent to do research across local files, shell commands, and web lookups.

The current repo contains the orchestrator backend, MCP server, tool layer, macOS app shell, and a separate Go-based remote control-plane scaffold. The architecture is coherent, but several headline features are still incomplete, especially the end-to-end voice path.

## Status

| Area | Status | Notes |
|---|---|---|
| TypeScript backend | In progress | Runs local HTTP, WS, SSE, MCP, and tool orchestration |
| macOS app | In progress | Native UI exists and builds, but some features are still stubbed |
| Voice mode | In progress | UI and realtime client exist, full audio pipeline is not complete |
| MCP surface | In progress | Implemented, but needs hardening and protocol cleanup |
| Remote control plane | Scaffold | Go service currently exposes health/readiness only |

## Run locally

### Prerequisites

- `pnpm`
- `bun`
- Xcode + `xcodebuild`
- `xcodegen` for regenerating the macOS project

### Backend

```bash
pnpm install
pnpm dev
```

The backend listens on `http://127.0.0.1:4317` by default and exposes:

- `GET /health`
- `GET /state`
- `POST /chat`
- `POST /chat/sync`
- `GET /mcp`
- `POST /mcp`
- WebSocket on the same port

### macOS app

```bash
pnpm macos:build
```

## Key features

- **Local orchestrator**: routes user requests, manages threads, and decides whether to answer directly, inject text, or run a sub-agent
- **Tool layer**: bash, file read/write, glob, grep, and placeholder web search
- **MCP server**: exposes chat and tool operations over JSON-RPC
- **macOS client**: native SwiftUI app with chat, status, and voice-mode UI
- **Research mode**: orchestrator can spin up a focused sub-agent path for search-oriented tasks
- **Remote scaffold**: separate Go service intended for future zero-trust remote access

## Architecture

```text
 [You]
   |
   v
 [macOS App] <----WS/SSE/HTTP----> [Nessie Backend]
                                       |
                                       +--> [Orchestrator]
                                       +--> [Tool Layer]
                                       +--> [MCP Server]
                                       +--> [Realtime Voice Client]

 [Remote Control Plane (Go)]
   |
   +--> separate scaffold for future remote access
```

## Repository structure

```text
assets/        Project artwork and icons
docs/          Product brief, build plan, remote docs, review findings
macos/         Native macOS app
remote/        Go remote control-plane scaffold
src/           TypeScript backend, orchestrator, tools, MCP, voice client
```

## Documentation

| Doc | Description |
|---|---|
| [Product Brief](docs/brief.md) | Vision, modes, architecture, MVP direction |
| [Build Plan](docs/build-ai-coworker.md) | macOS implementation plan |
| [Remote Brief](docs/remote/brief.md) | Remote control-plane scope |
| [Remote Tech Stack](docs/remote/techstack.md) | Remote service technology choices |
| [Remote SSO](docs/remote/sso.md) | Remote authentication notes |
| [Validated Findings](docs/review-findings.md) | cleaned review of the repo's real issues |

## License

Apache 2.0
