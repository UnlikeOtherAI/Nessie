# OpenClaw Research — Implementation Status

> **Status**: historical tracking note tied to the original OpenClaw research pass.

> This document tracks the 11 suggested improvements from the original deep research documents and their implementation status.

## Completed

### ✅ 2. Merged into a single canonical document
**File**: `docs/openclaw-reference.md`

Replaced both `openclaw-deep-research.md` (Native Mobile) and `openclaw-deep-research-report.md` (Business Operations) with a single 9-part canonical reference:

- Part 1 — What OpenClaw Is (architecture diagram, agent loop, Gateway role)
- Part 2 — Protocol Reference (WS + HTTP surfaces, auth flows, session model, `connect` frame, auth error codes)
- Part 3 — Live Gateway Walkthrough (annotated startup, wscat handshake, chat.send round-trip, curl examples)
- Part 4 — Business Deployment (hosting, channels, email, automation, Lobster, deployment checklist)
- Part 5 — Mobile Client Architecture (Feature Router, build-vs-buy decision tree, top-9 feature table)
- Part 6 — Security, Compliance & Hardening (threat model, hardening checklist, UK/EU GDPR DPIA triggers, data flow, retention template)
- Part 7 — Alternatives Comparison (agent orchestration vs LangGraph/crewAI/AutoGen; workflow automation vs n8n/Temporal/Zapier/Make; macOS menu bar vs OpenClaw node)
- Part 8 — Gap Analysis summary (pointing to `docs/openclaw-gap-analysis.md`)
- Part 9 — Testing Playground (pointing to `testing/openclaw/`)

### ✅ 3. Added live Gateway walkthrough
**File**: `docs/openclaw-reference.md` Part 3

Includes:
- Annotated `openclaw gateway` startup with flag table
- Annotated `wscat` handshake with exact JSON frames
- Annotated `chat.send` → streaming events → final response round-trip
- Full `curl` examples for `/v1/chat/completions`, `/v1/responses`, `/sessions/{key}/history`, `/hooks/agent`, `/tools/invoke`

### ✅ 4. Added "what's different from OpenClaw" section
**File**: `docs/openclaw-gap-analysis.md`

Full gap analysis covering:
- What Helper Agent has (8 capabilities mapped to implementation)
- What OpenClaw has (16 capabilities)
- Direct comparison table (17 dimensions)
- Three integration paths: Helper as OpenClaw operator client, Helper as OpenClaw node, hybrid
- Recommendations for short/medium/long term
- What Helper Agent should NOT take from OpenClaw (skills marketplace, full tool policy, Pi runtime, Control UI)
- What Helper Agent should take from OpenClaw (session persistence, cron, webhooks, Lobster approvals)

### ✅ 5. Filled Protocol Reference gaps
**File**: `docs/openclaw-reference.md` Part 2

- `connect` frame: complete JSON with all documented fields (`minProtocol`, `client`, `role`, `scopes`, `auth`, `device`)
- `chat.send` response events: enumerated all `state` values (`running`, `delta`, `final`, `aborted`, `error`)
- `sessions.list` response: inferred row schema with field annotations
- HTTP `/sessions/{key}/history`: cursor pagination, SSE `follow=1` semantics, error cases
- `/tools/invoke`: full request shape + default HTTP deny list table
- Auth error codes: complete table with client action guidance

### ✅ 6. Added "build vs buy" decision tree for mobile
**File**: `docs/openclaw-reference.md` Part 5

- Decision tree: top-9 → native; else → WebView
- WebView → Native migration checklist (route → flag → implement → test → gate → remove flag → cleanup)
- Criteria for promotion: usage frequency, latency sensitivity, offline requirement, device integration need
- Effort-ranked top-9 feature table mapped to milestones A–D

### ✅ 7. Added testing/playground section
**Files**: `testing/openclaw/`

- `docker-compose.yml` — local Gateway with persistent volume, health check, named networks
- `wscat-connect.sh` — annotated WS connection script with `--auth` fallback for older wscat
- `http-examples.sh` — curl commands for all HTTP endpoints (health, chat completions, responses, session history, tools invoke, hooks)
- `mock-gateway-server.ts` — minimal mock WS server implementing connect, chat.*, sessions.*, config.*, device.pair for contract testing
- `README.md` — quick start guide for both real Gateway and mock approaches

### ✅ 8. Addressed mobile push strategy gap
**File**: `docs/openclaw-reference.md` Part 5

Detailed push strategy section covering:
- Relay architecture (why: avoids storing raw APNs/FCM tokens on Gateway)
- Full iOS APNs relay sequence diagram (Register → Associate → Send → Silent push → Reconnect → Deliver)
- Android FCM planned path and design guidance
- Android foreground service for "always-on" mode
- iOS background limitations (silent push throttling, BGTaskScheduler as supplement)

### ✅ 9. Added legal section (practitioner POV)
**File**: `docs/openclaw-reference.md` Part 6

- DPIA trigger criteria: special category data, systematic monitoring, scale
- Data flow diagram: ingress → Gateway → team file → external tools → persistence
- Retention policy template table: transcripts, team, credentials, hook logs, skills
- Processor checklist for skills/plugins: code review, logging audit, scope validation, SSRF review

### ✅ 10. Added "why not just use X" section
**File**: `docs/openclaw-reference.md` Part 7

- Concrete comparison matrices:
  - Agent orchestration: OpenClaw vs LangGraph vs crewAI vs AutoGen (7 dimensions)
  - Workflow automation: OpenClaw vs n8n vs Temporal vs Zapier vs Make (9 dimensions)
  - macOS app: Helper Agent vs OpenClaw node app (10 dimensions)
- Decision guidance for each alternative category

### ✅ 11. Gap analysis: what we have vs what OpenClaw has
**File**: `docs/openclaw-gap-analysis.md`

Full analysis covering:
- Helper Agent capabilities (voice, input injection, orchestrator, tools, UI)
- OpenClaw capabilities (channels, WS protocol, tools, session model, cron, push)
- 17-dimension comparison table
- Three integration paths with implementation notes and effort estimates
- Short/medium/long term recommendations

---

## Pending Live Verification

The following items need to be verified against a **live OpenClaw Gateway instance** (running `openclaw gateway`) and the **TypeBox source schemas** (`packages/gateway/src/protocol/`) before use in production clients or implementations:

### Protocol schemas
- [ ] `connect.params` full field set — confirm optional fields (`locale`, `timezone`, etc.)
- [ ] `hello-ok.auth` lifecycle fields — confirm `expiresAt` presence, token rotation methods
- [ ] `chat.send` `state` enum — confirm complete list including intermediate states (`thinking`, `tool_use`, etc.)
- [ ] `chat.send` `usage` object shape — confirm which fields are populated and in what units
- [ ] `sessions.list` response row schema — extract from schema export (`openclaw schema export` if available)
- [ ] `sessions.spawn` — confirm existence, exact params, and response shape
- [ ] `node.invoke` — confirm `nodeId`/`command`/`args` semantics and response format
- [ ] `sessions.patch` enum values — confirm `thinkingLevel`, `reasoningLevel`, `verboseLevel`, `elevatedLevel` strings

### HTTP API
- [ ] `/tools/invoke` default HTTP deny list — verify from `packages/gateway/src/http/denyList.ts` or equivalent
- [ ] `GET /sessions/{key}/history` cursor encoding — confirm format (base64 JSON? opaque string?)
- [ ] `GET /sessions/{key}/history` SSE event names in `follow=1` mode
- [ ] `GET /sessions/{key}/history` `limit` server-side cap
- [ ] `POST /v1/responses` SSE event type enumeration
- [ ] `gateway.auth.rateLimit` threshold values

### CLI / Operations
- [ ] `openclaw gateway --help` — confirm all flags
- [ ] `openclaw devices approve` — confirm exact CLI for device pairing approval
- [ ] TypeBox schemas for code generation — check if `openclaw schema` or similar exports JSON Schema / OpenRPC spec

### Configuration
- [ ] `tools.profile` valid values — confirm `"messaging"`, `"all"`, `"none"`, etc.
- [ ] `channels.*.policy` valid values — confirm `pairing`, `allowlist`, `open`, `disabled`
- [ ] `gateway.controlUi.allowedOrigins` default behaviour and validation

---

## How to Verify

1. Start a local Gateway: `docker compose -f testing/openclaw/docker-compose.yml up -d`
2. Inspect TypeBox source: clone `github.com/openclaw/openclaw` and check `packages/gateway/src/protocol/`
3. Run `openclaw gateway --verbose` and capture traffic with `wscat` for WS protocol details
4. Run `curl` commands from `testing/openclaw/http-examples.sh` against the live Gateway
5. Use `testing/openclaw/mock-gateway-server.ts` for offline contract testing (update it with verified shapes)
