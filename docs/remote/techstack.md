# Remote — Tech Stack

The [brief](brief.md) picks the standards (WireGuard, ICE/STUN/TURN, OIDC,
OPA, coturn, OpenTelemetry). This document picks the **implementation
language and libraries** that realize them. The scope target is a single user
reaching their own machines from anywhere; the stack choices still scale up
to the full multi-user brief without rework.

## Summary

| Concern               | Choice                                                        |
|-----------------------|---------------------------------------------------------------|
| Language              | **Go 1.23+**                                                  |
| HTTP router           | `net/http` (stdlib `ServeMux` with 1.22+ method patterns)     |
| Identity              | `authentication.unlikeotherai.com` — see [sso.md](sso.md)     |
| JWT verification      | `github.com/golang-jwt/jwt/v5` (HS256, shared secret)         |
| WireGuard control     | `golang.zx2c4.com/wireguard/wgctrl` (`wgctrl-go`)             |
| ICE / NAT traversal   | `github.com/pion/ice/v3`                                      |
| STUN / TURN relay     | **coturn** (external process, TURN REST API credentials)     |
| Policy engine         | `github.com/open-policy-agent/opa/rego` (embedded)            |
| Durable store         | **PostgreSQL** via `github.com/jackc/pgx/v5`                  |
| Migrations            | `github.com/golang-migrate/migrate/v4`                        |
| Ephemeral store       | **Redis** via `github.com/redis/go-redis/v9`                  |
| Observability         | OpenTelemetry Go SDK + OTLP exporter                          |
| Structured logging    | `log/slog` (stdlib) with OTel bridge                          |
| OpenAPI codegen       | `github.com/oapi-codegen/oapi-codegen/v2`                     |
| Lint                  | `golangci-lint`                                               |
| Test                  | `go test`, `testify/require`, `dockertest` for integration    |
| Container             | Distroless `static-debian12` multi-stage image                |

## Why Go

1. **Ecosystem alignment.** Every moving part in the brief has a first-class
   Go implementation — `wgctrl-go` is the canonical WireGuard control
   library, `pion/ice` is the reference ICE stack, OPA embeds natively
   through `rego` with no IPC, and the OTel Go SDK is stable.
2. **Operational fit.** The server is a long-running daemon coordinating
   network state. Go's static single-binary deployment, low idle footprint,
   goroutine concurrency, and mature `net/http` make this the boring correct
   choice.
3. **Repo layout.** The `/cmd/…`, `/internal/…`, `/migrations` layout in the
   brief is idiomatic Go and maps 1:1 to Go module conventions.
4. **Rejected alternatives.**
   - **Rust (axum/tower):** safer and faster, but slower to iterate, no
     first-class WireGuard control bindings, and ICE/TURN tooling lags Go.
     Overkill for the single-user MVP and for future scaling.
   - **Node/TypeScript:** matches the existing helper orchestrator but has
     no native WireGuard control, poor ICE story, and significantly worse
     fit for long-running low-level networking work.

## Component → library map

Mapping each brief component to its concrete implementation:

- **Control API (§1)** — `net/http` stdlib mux, handlers in
  `internal/admin` and feature-specific `internal/*` packages. OpenAPI spec
  in `api/openapi/openapi.yaml`; server types generated via `oapi-codegen`.
- **Identity adapter (§2)** — `internal/auth`. Verifies UOA access tokens
  (HS256 JWT) with `golang-jwt/jwt/v5`, mints short-lived internal session
  tokens (also HS256 JWT, separate secret), maps UOA `sub`/email into the
  internal `User` principal. Details in [sso.md](sso.md).
- **Device bootstrap & registry (§3)** — `internal/bootstrap`,
  `internal/devices`. Single-use bootstrap tokens stored in Postgres with
  short TTL; device record stores WireGuard public key only (never private).
- **Service catalog (§4)** — `internal/services`. Devices POST manifests on
  heartbeat.
- **Tunnel coordinator (§5)** — `internal/tunnel`. Uses `wgctrl-go` to
  configure a server-side WireGuard interface if the server itself joins the
  overlay; otherwise emits peer config fragments to devices. Overlay IP
  allocation from a configurable CIDR, persisted in Postgres.
- **Session broker (§6)** — `internal/sessions`. State machine in Go;
  candidate buffers in Redis with per-session TTL; policy check inline
  before candidate exchange begins.
- **NAT traversal (§7)** — `internal/nat`. Delegates to coturn for STUN and
  TURN. Control plane mints short-lived TURN credentials using the
  long-term-credential HMAC scheme coturn supports (TURN REST API draft),
  tracks allocations via coturn's Redis backend for audit.
- **Policy engine (§8)** — `internal/policy`. Embeds OPA via
  `opa/rego.New(...).PrepareForEval(...)`. Policies live as `.rego` files
  under `internal/policy/rules/`. Single-user MVP ships one rule:
  `allow if input.subject.sub == data.owner_sub`.
- **Audit log (§9)** — `internal/audit`. Append-only Postgres table
  `audit_events` with HMAC-chained `prev_hash` for tamper evidence.
  Correlation ID = OTel trace ID.
- **Observability (§10)** — `internal/telemetry`. OTel tracer + meter
  providers initialized at startup, OTLP gRPC exporter, `log/slog` handler
  attaches trace IDs to every line.
- **Persistence (§11)** — `internal/store`. Postgres for durable state via
  `pgx/v5` (no ORM; queries in `.sql` files compiled with `sqlc` if it
  earns its keep later). Redis for ephemeral state via `go-redis`.
- **Admin surface (§12)** — `internal/admin`. Same HTTP server, separate
  route group, protected by the same session token with an `admin` claim.

## Data stores

- **PostgreSQL 16+** — durable state. Single database for the MVP; schemas
  by concern (`auth`, `devices`, `sessions`, `audit`, `policy`).
- **Redis 7+** — ephemeral state only. Heartbeat TTL, candidate buffers,
  rate-limit counters, distributed locks. Never the source of truth.

Migrations are SQL-first under `remote/migrations/`, applied by
`golang-migrate` on startup in a separate `migrate` subcommand.

## Observability

OpenTelemetry instrumentation is wired in from the first commit:

- Traces: every HTTP handler, every policy evaluation, every session
  transition, every coturn credential mint.
- Metrics: `remote_active_devices`, `remote_active_sessions`,
  `remote_connect_latency_ms`, `remote_direct_connect_ratio`,
  `remote_relay_fallback_total`, `remote_policy_deny_total`,
  `remote_auth_failures_total`.
- Logs: `slog` JSON handler with trace ID correlation.

Exporter default: OTLP over gRPC to `localhost:4317`. If unset, the SDK runs
as a no-op — the server still runs and emits to stdout.

## Build and tooling

- Module path: `helper/remote` (placeholder; move to
  `github.com/UnlikeOtherAI/helper/remote` when the repo gets a remote).
- `go build ./cmd/control-server` produces a single static binary.
- `golangci-lint run` in CI; enabled linters include `govet`, `staticcheck`,
  `errcheck`, `gosec`, `revive`, `gocritic`.
- Tests: `go test ./...`. Integration tests spin up Postgres and Redis via
  `dockertest`. A `testdata/` fixtures directory per package.
- Container image: multi-stage Dockerfile producing a distroless
  `gcr.io/distroless/static-debian12:nonroot` final image.

## Single-user MVP scope

For the first user reaching their own machine, only these subsystems are
strictly required:

1. `internal/auth` — verify UOA token, issue internal session.
2. `internal/bootstrap` + `internal/devices` — enroll one or two machines.
3. `internal/tunnel` — generate WireGuard peer configs.
4. `internal/sessions` — minimal connect flow, candidate exchange.
5. `internal/nat` — coturn integration for TURN fallback.
6. `internal/store` — Postgres schema for the above.
7. `internal/telemetry` — stdout logs; OTel exporter optional.

Components deferred past MVP but kept in the code layout so they can be
filled in without restructuring:

- `internal/services` — service catalog (hardcoded single service for MVP).
- `internal/policy` — embed OPA but ship a one-rule policy file.
- `internal/audit` — simple append-only table; HMAC chaining can land later.
- `internal/admin` — CLI-only admin at first; HTTP admin comes later.
