# OpenClaw Research — Suggested Improvements

## Comparison of the two documents

| Aspect | `openclaw-deep-research.md` (Native Mobile) | `openclaw-deep-research-report.md` (Business Operations) |
|---|---|---|
| Focus | Mobile client architecture, protocol deep-dive | Business operations, deployment, security |
| Audience | Mobile developers, architects | Business operators, security teams, DevOps |
| Strength | Detailed protocol/API mapping with explicit effort estimates | Comprehensive threat model and hardening checklist |
| Gap | Lacks hands-on deployment/runbook content | Lacks concrete API details (WS frames, HTTP schemas) |
| Gap | No actual OpenClaw Gateway code or schema references | No native mobile or client-side architecture |
| Gap | Protocol details sourced from cited docs, not verified against live Gateway | Security events are snapshot-in-time (Feb 2026) and will stale |

## What to improve

### 1. Verify protocol details against live Gateway

Both documents source protocol specifics (WS frame shapes, `chat.send` params, `sessions.patch` fields, etc.) from cited docs. The OpenClaw Gateway is open source. Cross-reference against:

- The actual TypeBox schemas in `packages/gateway/src/protocol/` or equivalent source.
- A running Gateway instance via `openclaw gateway --help` and introspected WS traffic.
- The JSON-Schema / OpenRPC specs if exported by the Gateway.

This would validate field names, optionality, enum values, and default limits that may have drifted from docs.

### 2. Merge into a single canonical document

The two docs cover the same project but talk past each other. A merged structure would serve readers better:

- **Part 1 — What OpenClaw is** (architecture diagram, agent loop, Gateway role)
- **Part 2 — Protocol reference** (WS + HTTP surfaces, auth flows, session model)
- **Part 3 — Mobile client architecture** (native-first strategy, Feature Router, API mapping)
- **Part 4 — Business deployment** (hosting, channels, automation, hardening)
- **Part 5 — Security & compliance** (threat model, hardening checklist, GDPR framing)
- **Part 6 — Roadmap & gaps** (what's missing, what to build next)

### 3. Add a live Gateway walkthrough section

Both docs describe mechanisms but don't guide the reader through a real session. Add:

- Annotated `openclaw gateway` startup output (flags, ports, health checks).
- Annotated WebSocket handshake captured via `wscat` or similar.
- Annotated `chat.send` → streaming events → `chat.history` round-trip.
- Annotated `/hooks/agent` curl example with a real payload.

### 4. Add a "what's different from OpenClaw" section specific to this project

This project (the Helper Agent) already has:

- Voice-first input via OpenAI Realtime API.
- macOS accessibility/input injection.
- Multi-agent orchestration.

Map these onto OpenClaw's architecture: where do they overlap, where do they diverge, and what would it take to make this Helper Agent act as an OpenClaw operator client vs an OpenClaw node?

### 5. Fill the Protocol Reference gaps

- `connect` frame: enumerate all fields in `connect.params` and `connect.params.device`.
- `chat.send` response events: enumerate all `state` values and when each fires.
- `sessions.list` response: show the actual row schema.
- HTTP `GET /sessions/{key}/history`: document all cursor/pagination semantics.
- `/tools/invoke`: enumerate the default HTTP deny list.

### 6. Add a "build vs buy" decision tree for mobile

The native mobile doc recommends a hybrid (native chat + WebView fallback). Make this concrete:

- Decision tree: is the feature in the top-9 table? → native. Otherwise → WebView.
- Migration checklist: how to move a WebView route to native (route → flag → implement → test → remove flag).
- Criteria for promoting a feature from WebView to native (usage frequency, latency sensitivity, offline requirement).

### 7. Add a testing/playground section

Both docs are design-oriented. Add:

- Minimal `docker-compose.yml` to spin up a local Gateway for experimentation.
- `wscat` commands for connecting as operator.
- Example `curl` calls for each HTTP endpoint.
- Mobile client mock server for contract testing without a real Gateway.

### 8. Address the mobile push strategy gap

The native mobile doc mentions APNs relay-backed push and FCM but doesn't specify:

- What the relay server is (OpenClaw-hosted? self-hosted?).
- How the app registers (`push.apns.register` frame shape and server response).
- How the Gateway sends a push wake end-to-end (sequence diagram).
- What happens on Android when the app is force-killed.

### 9. Legal section needs a practitioner POV

The GDPR framing in the business report is advisory-level. Add:

- Specific DPIA trigger criteria for OpenClaw deployments.
- Example data flow diagram (ingress → Gateway memory → transcript storage → external tools).
- Retention policy template for transcripts and session logs.
- Processor checklist for the skill/plugin ecosystem.

### 10. Add a "why not just use X" section

The alternatives in the business report are high-level. Add concrete comparison matrices:

- OpenClaw vs LangGraph vs crewAI vs AutoGen for agent orchestration.
- OpenClaw vs n8n vs Temporal for workflow automation.
- OpenClaw native node app vs a custom macOS menu bar app for personal use.

### 11. Capture the "what we have vs what OpenClaw has" gap analysis

Given this Helper Agent already has voice, orchestration, and macOS integration, the most valuable research would be:

- How would this Helper Agent consume OpenClaw as a backend? (Operator WS client connecting to OpenClaw Gateway.)
- How would OpenClaw use this Helper Agent as a node? (Helper as a node with voice/camera/tools capabilities.)
- Is there a hybrid where this project becomes an OpenClaw-compatible client?
