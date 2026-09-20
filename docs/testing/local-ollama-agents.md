# Local Ollama agents — verification record

This capability is an explicit `local_device` generative lane for a
person-owned agent on that same person's host. It is not the older
`delegate_local` executor tool proposal. The worker retains prompt assembly,
tool authorization, approvals, disclosure, checkpoints and messages; a local
host is only a bounded inference processor.

## Safety checks currently exercised

From the repository root, with dependencies installed:

```powershell
pnpm --filter @nessie/executor exec node --test --import tsx test/ollama-observed.test.ts
pnpm --filter @nessie/executor exec node --test --import tsx test/local-inference-host.test.ts
pnpm --filter @nessie/executor exec node --test --import tsx test/local-inference-receipts.test.ts
pnpm --filter @nessie/api exec tsx --test test/local-inference-attempt-result-route.test.ts
pnpm --filter @nessie/runtime exec node --test --import tsx test/uoa-live-entitlements.test.ts
pnpm --filter @nessie/runtime exec node --test --import tsx test/local-inference-policy.test.ts
pnpm --filter @nessie/admin exec node --test --import tsx test/local-inference-run-restart.test.ts
pnpm --filter @nessie/local-inference-host exec node --test --import tsx test/protocol.test.ts
pnpm --filter @nessie/worker exec node --test --import tsx src/run/execute/local-inference-binding.test.ts
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib local_inference
```

Results on 2026-09-20:

- `ollama-observed.test.ts`: 4 passed — read-only tags/show discovery, official
  remote markers, changed output digest, malformed/oversized observations.
- `local-inference-host.test.ts`: 9 passed — typed literal-loopback chat relay,
  signed heartbeat framing, per-chunk remote-marker rejection, and encrypted
  receipt replay without re-running an ambiguous model call. The live-shaped
  cases also cover Ollama's empty terminal content, disabled separate thinking,
  and models that do not report a context size.
- `local-inference-receipts.test.ts`: 2 passed — exact durable replay is
  idempotent, conflicting replay is rejected and expired protected receipts are
  not replayed.
- `local-inference-attempt-result-route.test.ts`: 4 passed — late and
  wrong-model receipts are fenced, an exact terminal replay is acknowledged,
  and a conflicting terminal replay is rejected.
- `uoa-live-entitlements.test.ts`: 6 passed — active link, authoritative denial
  and unavailable UOA authority remain distinct.
- `local-inference-policy.test.ts`: 2 passed — only the typed setting key is
  administrator-authored and its value is a boolean.
- `local-inference-run-restart.test.ts`: 2 passed — only an exact,
  server-authored local-host failure may render the fresh-run Restart control;
  malformed metadata cannot create it.
- `protocol.test.ts`: 4 passed — canonical signatures verify for executor and
  Desktop key encodings; endpoint ordering and conflicts stay deterministic.
- `local-inference-binding.test.ts`: 2 passed — admission pins exactly one
  binding revision/host epoch tuple and rejects a conflicting retry.
- `run-inference.test.ts`: 6 passed — a `local_device` pin is rejected at the
  provider boundary rather than resolving through the Ledger/cloud route.
- Desktop `local_inference`: 4 passed on Windows — native controls reject
  document/foreign-origin callers, release origins require TLS, a protected
  machine-key rotation advances both local fences, and the enrollment export is
  a public Ed25519 SPKI PEM only.

The direct Desktop bridge uses DPAPI for the current Windows user and native
Keychain/Secret Service stores on macOS/Linux; it has no plaintext fallback.
It creates or rotates its key only after an OS-native confirmation, stops on
Desktop exit, and exposes no general process or fetch command. Its
consent-display and host-loop requests are machine-signed; webview input cannot
choose the identity or model being confirmed.

## Transport retention and recovery

Each attempt is bound to a canonical request digest, its selected model digest,
and a deterministic invocation id. Retrying the same logical request reuses
that receipt rather than starting another Ollama call or creating another tool
effect. The server accepts a receipt only before its deadline and only for the
pinned model digest. It keeps encrypted terminal attempts and acknowledged
frames for at most one hour; the API maintenance sweep holds a cluster-wide
lock while it clears that bounded transport state, including data for hosts
that never reconnect. A `response.error`
frame is an error delivery, never an empty successful answer. Live local text
uses the ordinary SSE redactor and emits its held tail exactly once after the
receipt completes.

The agent list, agent detail header and addressed-agent conversation drawer
consume the server-derived availability projection only when the record has a
local binding. They reuse `PresenceBadge` for online/offline/unknown readiness,
keep it separate from human Presence, and offer the registered Model repair
link only to the agent's owner/custodian. The channel drawer is a single-agent
surface, so it does not turn a roster or mention picker into one request per
agent.

The general type checks run through the workspace packages.

## Required release-gate coverage

The complete release suite must additionally run with `DATABASE_URL` explicitly
set and through Turbo, for example:

```powershell
$env:DATABASE_URL = 'postgresql://nessie:nessie@127.0.0.1:5432/nessie_test'
pnpm exec turbo run test --filter=@nessie/api --filter=@nessie/worker --filter=@nessie/executor
pnpm --filter @nessie/worker build
```

It must include the reconciled stop-ship matrix: missing provider provenance,
UOA denied versus unavailable, Save/consent/policy races, host key rotation,
remote Ollama markers, endpoint conflict, receipt expiry/replay, malicious tool
calls, upgrade rollback fencing and a no-op capability smoke. Browser and
native work must be inspected in headless Playwright; screenshots belong under
`e2e/screenshots/local-ollama-agents/`. Windows verification does not establish
macOS or Linux native support.

## Real Ollama boundary

Do not pull, delete, alter configuration, stop, or otherwise mutate a person's
Ollama installation. A real-device check is read-only and only follows product
consent: list the selected literal loopback endpoint and make the bounded
synthetic no-op inference probe.

Run the opt-in product-host smoke with:

```powershell
pnpm --filter @nessie/executor smoke:local-ollama
```

On 2026-09-20 it autodetected 11 models on the installed Ollama 0.34.1,
selected the smallest structurally local text model (`gemma4:12b`), and passed
one bounded 24-token attempt through `LocalInferenceHostLoop`. The terminal
receipt was local-only, its content matched the acknowledged stream exactly,
and its finish reason was `stop`. The smoke issued only the product's bounded
version/tags/show discovery requests and one `/api/chat`; it did not pull,
create, rename, delete, reconfigure or stop any model or daemon.

## Durable browser evidence

Run the deterministic headless component/API-boundary proof with the worktree's
configured ports:

```powershell
pnpm --filter @nessie/admin test:e2e:local-ollama-agents
```

It covers the browser's no-scan doorway and friendly online/offline/unknown
states, shared Connections/executor host controls, exact model-binding approval
with Save-only activation, list/detail availability and editable team versus
inherited locked-person policy. It also checks keyboard reachability at phone
width. Screenshots are written to `e2e/screenshots/local-ollama-agents/` and
uploaded by `Browser Suites` as `local-ollama-agents-screenshots`.

The fixture is preview-only under `NESSIE_LOCAL_OLLAMA_AGENTS_E2E_FIXTURE=1`
and never appears in an ordinary production bundle. It exercises real shared
admin components over deterministic API responses; it intentionally does not
claim a live Ollama, native shell, executor or UOA integration check.
