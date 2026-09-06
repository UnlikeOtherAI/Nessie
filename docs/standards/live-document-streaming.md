# Live document streaming

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **Live document streaming taps the model's own tool-call arguments, and its
  live path never touches durable storage.** `kb_document_compose` emits the
  document as its `markdown` argument; the enriched `tool_call.delta` events
  feed a per-run recorder whose *live* lane publishes each provider chunk over
  `publishSseEphemeral` (notify-only) and whose *durable* lane coalesces
  separately for bootstrap — two lanes precisely so a slow INSERT cannot delay
  a token. That split is also why the live lane takes **no** lock: a durable
  publish serialises per thread on `pg_advisory_xact_lock` so its id order is
  its commit order (horizontal-scaling invariant 9), while an ephemeral one
  writes no row and moves no watermark, so it must never wait behind that lock.
  The drain loop calls the recorder synchronously; anything that would
  make the provider read wait belongs on a lane, not in the callback. Session
  identity is `(runId, invocationId, toolCallId)` because indexes restart per
  attempt and retries re-issue the same iteration. Never publish a document
  delta durably, never emit a partial escape or lone surrogate to a client
  (`createPartialJsonScanner` owns that invariant), and never save a document
  the streamed text does not byte-match. Interruption of any kind saves
  nothing. **Editing an existing document is deltas, never a rewrite**
  (`kb_document_edit`): `{find, replace}` pairs anchored to an exact single
  match, streamed in document order, with the edit site published *before* its
  replacement text so a viewer can move there and wait. The streaming preview
  (`document-stream-edit.ts` tracker) and the save (`applyDocumentEdits`) are
  deliberately independent implementations and the save asserts they agree —
  never collapse them into one, or the check becomes a restatement. An
  ambiguous anchor is skipped in the preview and refused in words at save.
  Spec: `docs/plans/2026-08-13-live-document-streaming/overview.md`.

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "Live document streaming — watch a document being written".


`kb_document_compose` writes a markdown document as its own `markdown` tool
argument and saves it as a real **`.md` file node**; the person watches the
tokens arrive in a centered popup that renders markdown progressively. Core
invariants (two lanes, synchronous recorder, session identity, partial-JSON
scanner, byte-match save, interruption saves nothing, edits are deltas): stated above.
The mechanics beyond those —
restriction barrier, connector enrichment, lane details, cancellation, SSE
events and REST surface — are in
[docs/live-document-streaming.md](../live-document-streaming.md). Spec:
[docs/plans/2026-08-13-live-document-streaming/overview.md](../plans/2026-08-13-live-document-streaming/overview.md).
