# Live lane, envelopes, presence

## The lane

One new hijacked SSE route, one new hub connection kind, one new NOTIFY
envelope kind. Nothing durable rides it.

`GET /api/knowledge-base/pages/:pageId/live?clientId=` (`api/src/routes/knowledge-spreadsheet-live.ts`):

1. `requireActorContext`; `accessPageSpace(ctx, pageId, viewer, 'read')`
   (the route helper from `knowledge-base-access.ts`, which also enforces
   every-version-readable); page must be `kind === 'spreadsheet'`.
2. `reply.hijack()`; headers from `buildStreamCorsHeaders({origin,
   allowedOrigins, mode, teamHostBaseDomain})` — **pass `teamHostBaseDomain`**
   (on `main` since PR #501 for `events.ts`, `thread-stream.ts` and
   `designer.ts`; `RouteDeps` carries it there), `Cache-Control: no-cache,
   no-transform`, `X-Accel-Buffering: no`, `setNoDelay(true)`, 15 s keepalive
   comments, `: stream connected` — copy `thread-stream.ts` as it is on
   `main` after PR #501 (this branch predates it; it rebases onto `main`
   before Phase 1).
3. `realtimeHub.addDocumentConnection({ kind: 'document', pageId,
   organizationId, spaceId, userId, clientId }, reply.raw)`; removal on
   `close`, which also publishes `sheet.presence.leave` for that `clientId`.
4. No `Last-Event-ID`, no hydration, no pending buffer: the lane is
   ephemeral by construction. The client bootstraps over REST **after** the
   stream is open; the bootstrap carries `headSeq`, so anything the stream
   delivered with a lower `seq` is discarded, anything higher is applied in
   order, and a gap is filled from `…/spreadsheet/ops?afterSeq=`.
5. Immediately after registering, the route publishes
   `sheet.presence.request` for the page so peers re-announce.

### Hub changes (Phase 2, `api/src/realtime/`)

- `notification-delivery.ts`: `DocumentSseConnection = { kind: 'document',
  pageId, spaceId, organizationId, userId, clientId, response, saturated }`
  in its own Set; `deliverNotification` gains a branch **before** the
  `message` guard:

  ```ts
  if (notification.kind === 'document') {
    for (const c of documentConnections) {
      if (c.pageId !== notification.document.pageId) continue
      if (!(await gatesFor(c, c).knowledgePage(c.pageId))) continue   // 5 s memo
      if (c.saturated) continue                                         // ephemeral: drop, never queue
      writeDocumentSseEvent(c, notification.document)
    }
    return
  }
  ```

  The file is near the 500-line cap, so the branch body and the connection
  bookkeeping live in `api/src/realtime/document-lane.ts`, called from the
  two seams (`deliverNotification`, `addSseConnection`).
- `delivery-entitlements.ts`: `RealtimeDeliveryEntitlements` gains
  `canAccessKnowledgePage({ pageId, organizationId, userId })`, implemented
  in `hub.ts` with `loadSpaceViewer` + `canReadSpace` + the version basis
  check, memoised 5 s by `createEntitlementGate`.
- Shutdown: document connections end in `closeLiveConnections` like the
  others.

### Envelope (Phase 2, `packages/runtime/src/realtime-publish.ts`)

```ts
| {
    kind: 'document'
    document: {
      pageId: string
      organizationId: string
      event: DocumentSseEventName   // 'sheet.ops' | 'sheet.presence' | 'sheet.presence.leave'
                                    // | 'sheet.presence.request' | 'sheet.snapshot' | 'sheet.closed'
      data: unknown                 // validated by DocumentSseEventSchema at publish time
      ts: string
    }
    /** Always empty — the compatibility shim every non-'sse' kind carries. */
    scopes: []
  }
```

Inert to a previous-build replica by the same construction as `sse-ref` and
`auth`: no top-level `eventId`, no `message`, `scopes` present and empty.
**Do not flatten `document.*` to the top level** until no deployed replica
predates it (Phase 5 records the earliest safe date in the standards file).

Publishing: `PgRealtimeTransport.publishDocumentEphemeral(pageId,
organizationId, event, data)` beside `publishSseEphemeral` — plain
`notifyRealtime`, no row, no lock, measured against
`NOTIFY_PAYLOAD_LIMIT_BYTES` by the one `notifyEnvelope` door. A `sheet.ops`
event carries the batch's `diffs` as base64 **only when the whole envelope
fits under the cap**; otherwise `diffs: null` and the client fetches that
`seq` from the catch-up route (a 2 000-cell paste is ~15 KB of diffs, so
most pastes take this path; single-cell edits are ~50 bytes and ride
inline). One function, `buildSheetOpsEvent`, decides, so the cap check cannot
be forgotten. Presence frames are schema-bounded (≤ ~600 bytes).

Schemas live in `packages/schemas/src/realtime-document.ts` and are exported
through the `realtime.ts` barrel; the admin's SSE reader validates every
frame and drops unknown events.

The worker publishes through its own `PgRealtimeTransport`; every API
replica's hub LISTENs on `nessie_realtime`. `applySpreadsheetBatch` takes a
`publish` callback so each process hands in its own transport.

## Presence protocol

Presence is a **broadcast of ephemeral facts, not a stored roster**. The
server validates, stamps and forwards; nothing is stored.

### Frame

```ts
SpreadsheetPresenceFrame = {
  clientId: string                 // one per open pane (uuid)
  sheet: number                    // IronCalc sheet index
  selection: { r0, c0, r1, c1 } | null   // 1-based inclusive, from getSelectedView().range
  cursor: { r, c } | null          // getSelectedView().row/column
  draft: { r, c, text } | null     // editor textarea value, ≤ 256 chars, before commit
  ts: string
}
SpreadsheetPresenceEvent = frame & { pageId, sheetName, actor: SpreadsheetActor }
```

A `sheet.ops` batch whose summary carries `filter` (a filter model change)
also updates every client's filter chips; the summary is advisory for the
UI exactly as it is for the server (`storage-and-concurrency.md`).

`sheetName` is stamped by the server from `spreadsheet_heads.sheetNames` so
a peer on another sheet can be labelled without a lookup; the index is what
the overlay compares.

### Ingress

- People: `POST /api/knowledge-base/pages/:pageId/presence`. Read access
  suffices for `selection`/`cursor`; a non-null `draft` requires write
  access. A per-replica token bucket drops frames beyond
  `maxPresenceFramesPerSecond` per `(userId, clientId)` — a cache, not an
  authority. The server stamps `actor` (`displayName` from the user record,
  `color = presenceColorFor(userId)`). `DELETE …/presence?clientId=`
  publishes `sheet.presence.leave`; the client also sends it on `pagehide`
  and the lane sends it on socket close.
- Agents: worker `sheet_*` handlers publish frames through
  `publishDocumentEphemeral` with `actor = { type: 'agent', id: agentId,
  displayName, color }` where colour is the agent's stored
  `avatarBackgroundColor` or `fallbackAgentBackgroundColor(agentId)`
  (Phase 4 moves that function from `AgentAvatar.tsx` into
  `packages/schemas` beside the palette). See `agent-tools.md` §"Agent presence".

### Client behaviour

- Emit on selection change (every intercepted `setSelectedCell`,
  `setSelectedRange`, `onArrow*`, `onPageUp/Down`, `onExpandSelectedRange`,
  `onAreaSelecting`, `setSelectedSheet` call on the model — read
  `getSelectedView()` after the call), on draft input, and every 10 s as a
  heartbeat while visible; throttle to one frame per 100 ms, latest wins.
- Expire peers not heard from for 30 s; `leave` removes immediately.
- On `sheet.presence.request` re-send within a random 0–500 ms.
- Render (`admin-ui.md`): ranges as translucent fills with a 2 px border in
  the actor colour on the current sheet only, a name tag at the cursor cell,
  a draft ghosted inside its cell with a caret, an agent glyph before agent
  names. Peers on another sheet appear only in the avatar strip with the
  sheet name on hover. The strip is the presence *home* (Rule zero); the
  overlay is the in-context doorway.

## Ordering rules the client implements (`spreadsheet-live.ts`)

1. Keep `appliedSeq`. Apply `sheet.ops` only if `seq === appliedSeq + 1`
   (`model.pauseEvaluation(); applyExternalDiffs(bytes); resumeEvaluation();
   evaluate(); session.redraw()` — `WorkbookHost`'s `repaintGrid`, not a
   library method); buffer higher; after 250 ms with a gap,
   `GET …/ops?afterSeq=appliedSeq` and apply in order; discard lower. A
   `diffs: null` event is fetched by seq.
2. Skip batches whose `clientOpId` is in the local pending map (own echo);
   on ack, remove from pending and advance `appliedSeq` only if contiguous.
3. `structuralKind === 'restore'`, `sheet.snapshot` beyond a gap, or
   `SPREADSHEET_ENGINE_MISMATCH` → full re-bootstrap (one GET).
4. **Structural conflict (`409`) — replay intent, not bytes.** The sync
   layer records, for every pending batch, the list of mutating method
   calls it intercepted (`SpreadsheetIntent[]`). On 409: (a)
   `pauseEvaluation()`; `undo()` once per pending batch and discard the
   undo diffs that lands in the send queue (`flushSendQueue()` to drain);
   (b) apply the foreign `since` batches **above `appliedSeq`** — a
   structural batch arrives twice, on the lane and again in `since`, and
   `insertRows` is not idempotent — while shifting through **all** of them,
   because a row that moved moved whoever reported it first; (c) re-issue each
   recorded intent with row/column indexes shifted by the foreign structural
   batches' `structuralIntents` — **Phase 3b correction:** the summary is the
   writer's private record and is not on the wire, so the batch carries the
   structural intents it performed, and one that carries none cannot be rebased
   across at all (`shiftIntent(intent, since)` in
   `packages/spreadsheet/src/rebase.ts`; an intent whose target row/column
   was deleted, or a pending structural intent crossing a foreign
   structural one, is dropped and reported); (d) `resumeEvaluation();
   evaluate()`; (e) `flushSendQueue()` → one new batch with `baseSeq =
   headSeq`; resubmit. Show the one-line notice only when something was
   dropped ("Row structure changed by <name>; 1 edit could not be re-applied:
   B14").
5. While the stream is down: keep editing locally, queue batches, show the
   existing stream-retry state; on reconnect, catch up first, then flush the
   queue with rebased `baseSeq` (which may itself hit rule 4).
6. **Flush eagerly.** The sync layer flushes the send queue on a microtask
   after every intercepted mutation, so a pending batch is normally one user
   action and the window for a structural conflict is one round trip.

## Realtime kinds added

| Lane | Kind / event | Recoverable by |
|---|---|---|
| document (new) | `sheet.ops` | `GET …/spreadsheet/ops?afterSeq=` |
| document | `sheet.presence`, `.leave`, `.request` | not needed (re-announce) |
| document | `sheet.snapshot` `{versionId, seq}` | bootstrap / versions list |
| document | `sheet.closed` `{reason: 'archived'\|'deleted'\|'engine-migrating'}` | page GET |
| ws (existing) | none added | — |
| user SSE (existing) | none added | — |

`POST /mcp` (`mcp-endpoint.ts`) is also hijacked and passes no CORS
headers: the MCP transport writes its own response headers, and Fastify's
reply headers are dropped on hijack. That is **correct**, not a gap — MCP
clients are non-browser processes (Claude Desktop, agents, servers), the
global `@fastify/cors` still answers preflights, and no browser-hosted MCP
client is a Nessie surface. Phase 5 adds one sentence saying so to
`docs/standards/paired-agents.md`; the day a browser MCP client is
supported, that route gets `buildStreamCorsHeaders` like the streams.

Page-level facts a list needs (title, `updatedAt`, version count) travel the
existing way: `KnowledgePage.revision` bumps per batch; the admin invalidates
list queries on `sheet.snapshot` only, never per batch.
