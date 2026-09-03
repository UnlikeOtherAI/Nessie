<p align="center">
  <img src="assets/icon-trimmed.png" width="128" height="128" alt="Nessie icon">
</p>

<h1 align="center">Nessie</h1>

<p align="center">
  The Slack alternative for an AI world.<br>
  Channels, threads and DMs your team already knows &mdash; with agents that do the work in them.
</p>

<p align="center">
  <a href="docs/brief.md">Product Brief</a> &middot;
  <a href="docs/build-ai-coworker.md">Build Plan</a> &middot;
  <a href="docs/remote/brief.md">Remote Brief</a> &middot;
  <a href="docs/review-findings.md">Validated Findings</a>
</p>

---

## Screenshots

| Ask in a thread | It follows through | The team reads it |
|---|---|---|
| [<img src="web/public/screenshots/nessie-assistant.png" alt="A Nessie thread where the assistant drafts an all-team note about a new expense policy" width="280">](web/public/screenshots/nessie-assistant.png) | [<img src="web/public/screenshots/nessie-actions.png" alt="The assistant confirming it posted the note to #General and scheduled a follow-up check" width="280">](web/public/screenshots/nessie-actions.png) | [<img src="web/public/screenshots/nessie-channel.png" alt="The #General channel in Nessie showing the published expense policy note" width="280">](web/public/screenshots/nessie-channel.png) |
| The assistant drafts the note in the reply thread where it was asked. | It posts to `#General` and schedules the Monday follow-up itself. | Channels, threads and DMs, exactly where the team already looks. |

These are the same images the public site (`web/`) shows at [nessie.works](https://nessie.works).

## What it is

Nessie is a multi-tenant, self-hosted agentic work platform: channels, threads
and DMs your team already knows, with agents that do the work in them.
Organisations host their own instance.

### How it is organised

Identity and the organisation structure come from **UnlikeOtherAI (UOA)**, the
SSO. It owns two levels and the people in them, and Nessie mirrors them one for
one rather than keeping its own copy:

```text
Organisation                 ← one UOA organisation
  └── Workspace              ← one UOA team. A user can be in many.
        ├── Project          ← Nessie's own. UOA has no such concept.
        │     └── Channel
        └── agents, knowledge, boards, …
```

A **workspace is the SSO's team** — the same thing under the product's own
word, not a container for one. A **project is a construct within Nessie**: a
body of work living inside exactly one workspace, so "which workspace does this
project belong to?" always has exactly one answer.

The model in full, including the vocabulary rules and the one place the schema
currently contradicts it, is
[docs/standards/workspace-model.md](docs/standards/workspace-model.md).

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
 [Admin web UI]  [iOS / iPad]  [macOS]      ← the admin UI is the primary surface
        |             |            |
        +-------------+------------+
                      |
                HTTP / WS / SSE
                      |
              [Nessie API :5454] ──── [UnlikeOtherAI SSO]
                      |                 identity, organisations,
                      |                 workspaces (teams), membership
                      +--> [Worker / orchestrator]
                      +--> [Executors]
                      +--> [MCP connectors]
                      +--> [Postgres]
```

Nessie stores no second copy of what the SSO owns. It keeps the binding keys —
the external organisation id, the external workspace id, the user's subject —
and asks UOA for the rest.

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
| [Deployment](docs/deployment.md) | **Production deployment** (self-hosted, Hetzner + shared Caddy) |
| [Secret management](docs/secret-management-spec.md) | **A configured Infisical vault is required to save any secret** — scope, grants, and what is stored where |
| [Apple publishing & direct device delivery](docs/publishing-apple-testflight.md) | TestFlight releases and the default standalone phone/tablet delivery policy |
| [Running the native apps](docs/running-the-apps.md#default-physical-device-delivery) | Direct installation policy and local development paths |
| [Product Brief](docs/brief.md) | Vision, modes, architecture, MVP direction |
| [Build Plan](docs/build-ai-coworker.md) | macOS implementation plan |
| [Remote Brief](docs/remote/brief.md) | Remote control-plane scope |
| [Remote Tech Stack](docs/remote/techstack.md) | Remote service technology choices |
| [Remote SSO](docs/remote/sso.md) | Remote authentication notes |
| [Validated Findings](docs/review-findings.md) | cleaned review of the repo's real issues |

## License

Apache 2.0
