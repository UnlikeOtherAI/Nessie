# Mock-LLM testing harness

Deterministic, token-free fake inference provider for unit, integration, CI
smoke, and load tests. Every test that today hand-stubs `runInference` (e.g.
`worker/src/run/agentic-loop.test.ts`) can migrate to this harness; the same
scenario files drive the in-process loop seam, the full worker pipeline, and
load runs.

## Pieces

- **`@nessie/mock-llm`** (`packages/mock-llm`) — the harness package:
  - `loadScenario(name | path)` / `listScenarios()` — load and validate
    scenario JSON (zod). Bundled scenarios live in
    `packages/mock-llm/scenarios/`; `scenariosDir` points at them.
  - `createMockRunInference(scenario)` — in-process adapter matching the
    agentic loop's inference seam:
    `(messages, tools?) => Promise<InferenceResult>`.
  - `createMockLlmServer({ scenario, port? })` — OpenAI-compatible HTTP server
    (`POST /v1/chat/completions` with SSE streaming, `POST /v1/embeddings`
    returning deterministic vectors at `EMBEDDING_DIMENSIONS`, `GET /v1/models`,
    `GET /health`).
    The worker's real OpenAI connector talks to it unchanged via
    `NESSIE_MODEL_BASE_URL`.
  - `MockLlmEngine` — the shared scripted-turn engine behind both adapters.
- **Worker harness** (`worker/test-harness/`) — full-pipeline drivers:
  - `pipeline.ts` — seeds an isolated org/project/team/channel/user/agent,
    enqueues real `run.execute` jobs, and runs the real `executeRunJob` handler
    through `PgQueueProvider` subscribers (one per "worker replica").
  - `smoke.ts` — the CI smoke run (below).
  - `load.ts` — the load mode (below).

## Scenario files

One JSON file = one scripted multi-turn conversation. The next turn is selected
by counting assistant messages in the incoming request, so a single engine
serves any number of concurrent runs deterministically with no shared state.

```json
{
  "name": "channel-list-tool",
  "defaults": { "latencyMs": 0, "model": "mock-model" },
  "turns": [
    {
      "latencyMs": 20,
      "text": "Let me check which channels exist first.",
      "toolCalls": [
        { "toolName": "channel_list", "arguments": { "limit": 5 }, "toolCallId": "mock-call-channel-list-1" }
      ],
      "usage": { "inputTokens": 140, "outputTokens": 24 }
    },
    {
      "error": {
        "status": 429, "type": "rate_limit_error",
        "code": "rate_limit_exceeded", "message": "Rate limit exceeded", "latencyMs": 5
      }
    }
  ]
}
```

Per turn you can script:

- **Text and tool calls** — `text`, `toolCalls[]`, `finishReason`, `usage`.
- **Latency injection** — `latencyMs` per turn plus a scenario-level default.
- **Failure injection** — `error` with a provider-shaped status
  (400/401/403/429/500/502/503), `type`, `code`, `message`. The in-process
  adapter throws `MockLlmProviderError` (with `.status`/`.code`); the HTTP
  server returns the OpenAI error body at that status.
- **Streaming simulation** — `stream: { chunkSize, chunkDelayMs }` emits the
  text in fixed-size SSE chunks.

Bundled scenarios: `simple-answer` (one streamed text turn),
`channel-list-tool` (tool call → answer; smoke + default load scenario),
`rate-limited` (429 failure shape).

A conversation that outlives its script raises `MockScenarioExhaustedError` —
scripting bugs fail loudly instead of looping.

## CI smoke test

```
pnpm --filter @nessie/worker test:smoke
```

Requires Postgres (default `postgresql://nessie:nessie@localhost:55432/nessie`,
override with `DATABASE_URL`) with migrations applied — never resets the
container; it seeds its own namespaced org and cleans it up afterwards. The
`smoke` job in `.github/workflows/ci.yml` runs the same command against a
fresh service container.

It drives one full scenario — message → `run.execute` enqueue → agentic loop →
`channel_list` builtin tool call → completion — and asserts:

- run terminal state `completed` with start/finish timestamps,
- the assistant message equals the scripted answer,
- exactly one `ToolCall` row (`channel_list`, success),
- the `run.timing` `TaskEvent` (`outcome`, `inferenceCount=2`, `toolCount=1`),
- two `token_ledger_events` rows with the run's attribution and token usage,
- agent back to `idle`, task `done`.

## Load mode

```
pnpm --filter @nessie/worker test:load --runs 100 --workers 8
```

Flags: `--runs N` (default 25), `--workers W` (default 4 independent queue
subscribers — each runs the same claim loop a separate worker replica would),
`--scenario NAME` (default `channel-list-tool`), `--timeout MS`. Enqueues N
scripted runs concurrently and reports wall time, throughput, and p50/p95/max
for queue wait, per-run total, inference, and tool time (from the `run.timing`
events). Exits non-zero if any run does not complete, so it can gate CI later.

Baseline (2026-07-24, local dev container, Apple Silicon, scenario
`channel-list-tool` with 20 ms scripted latency per turn):

| Runs | Workers | Wall | Throughput | Queue wait p50/p95 | Run total p50/p95 | Failed |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 25 | 4 | 825 ms | 30.3 runs/s | 434 / 613 ms | 84 / 162 ms | 0 |
| 100 | 8 | 1548 ms | 64.6 runs/s | 848 / 1349 ms | 90 / 183 ms | 0 |

Queue wait scales with runs-per-worker as expected; per-run execution time
stays flat (~90 ms p50), so contention shows up in claiming, not in the loop.

## Migrating existing tests

Replace a hand-rolled `runInference` stub with the shared provider and a
scenario file:

```ts
import { createMockRunInference, loadScenario } from '@nessie/mock-llm'

runInference: createMockRunInference(await loadScenario('channel-list-tool'))
```

See `worker/test/mock-llm-loop.test.ts` for a complete example.
