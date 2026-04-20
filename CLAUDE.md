# Nessie

Personal voice-first AI agent for macOS with multi-agent orchestration.

@./AGENTS.md

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
- MDNS/Bonjour — backend advertises `_nessie._tcp` for local network discovery

## Git

- Work directly on `main`. Never create branches or PRs.

## Build

- Rebuild the admin after every turn where admin code changed: `pnpm --filter @nessie/admin build`

## Linting

- **TypeScript**: strict mode (`strict: true` in tsconfig), ESLint with `max-len`, `noImplicitAny`, `noUnusedLocals`
- **Swift**: SwiftLint with strict mode, warning treated as error in CI

## Ports — NON-NEGOTIABLE

- **API**: `5554` — always. Do not kill or restart without restarting on the same port.
- **Admin**: `5555` — always. Kelpie verification MUST use `http://localhost:5555`.
- Never use any other port for these services.

## Verification

- Every UI/frontend change must be verified using kelpie before the work is considered done.
- Run `kelpie "http://localhost:5555/<path>"` to screenshot the affected page and confirm correct rendering.
- Use Playwright (`mcp__plugin_playwright`) only as a fallback if kelpie cannot be launched. Always run Playwright headless unless the user explicitly requests otherwise.

## MCP Integration

All user-facing actions are available via the MCP server (`GET /mcp`, `POST /mcp`) speaking JSON-RPC 2.0. Any MCP client (Claude Code, etc.) can connect and use:

- Protocol methods: `tools/list`, `tools/call`, `resources/list`, `initialize`, `notifications/initialized`.
- Tool calls exposed by `tools/list`: chat (`send_message`), tool execution (`invoke_tool` → Bash/FileRead/FileWrite/Glob/Grep/WebSearch), conversation ops (`list_messages`, `delete_history`, `inject_message`, `list_sessions`), screenshot (`screenshot`), task lifecycle (`create_task`, `list_tasks`, `get_task`, `transition_task`, `spawn_task`, `get_spawn_status`), reviews/approvals (`submit_review`, `get_review_history`, `list_roles`, `request_approval`, `approve_task`, `reject_task`, `list_pending_approvals`), validators/metrics/alerts (`run_validators`, `get_metrics`, `get_task_metrics`, `get_alerts`), and OpenClaw interop (`openclaw_export_state`, `openclaw_agent_configs`, `openclaw_session_key`, `openclaw_resolve_key`).
- Voice placeholders: `voice_start` / `voice_stop` are listed but not implemented; there is no `stream_audio` tool in the server today.

For the full, authoritative list see [docs/functionality.md](docs/functionality.md#72-mcp-methods-available-through-tool-names).

## MDNS

The backend registers `_nessie._tcp` on port 4317 via Bonjour/mDNS on launch. Clients on the same network discover it automatically without hardcoded IPs.

## Docs

- [brief.md](docs/brief.md) — Full project brief
- [build-ai-coworker.md](docs/build-ai-coworker.md) — macOS app build plan
- Finished documents belong in `docs/done/`.
