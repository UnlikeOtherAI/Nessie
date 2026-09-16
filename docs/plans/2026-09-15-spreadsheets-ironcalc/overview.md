# Spreadsheets in Nessie documents — IronCalc build contract

Status: design complete and owner-approved (decisions below, 2026-09-16),
not started. Written 2026-09-15 for Ondrej; reworked the same day from a
FortuneSheet draft after the owner chose IronCalc. The integration branch
rebases onto `origin/main` (≥ `2c9963eff`) before Phase 1. This directory is a **build contract**: each file states decisions
other agents implement, in waves, without re-deriving them. When a decision
proves wrong during a phase, the phase changes this document in the same
turn and says why.

## Table of Contents

- [overview.md](overview.md) (this file) — goal, the ten decisions,
  architecture, phase table, ownership map, settled decisions, unknowns.
- [library-assessment.md](library-assessment.md) — what IronCalc is and is
  not, verified against its source and a live probe of the Node binding.
- [storage-and-concurrency.md](storage-and-concurrency.md) — canonical model,
  journal, sequencing, snapshots and versions, engine upgrades, import and
  export, indexing. Carries the shared contract
  (`packages/schemas/src/spreadsheet.ts`, Prisma).
- [realtime-and-presence.md](realtime-and-presence.md) — the per-document
  live lane, envelope, the presence protocol for people and agents, the
  client ordering rules.
- [agent-tools.md](agent-tools.md) — the builtin `sheet_*` and MCP
  `nessie_sheet_*` surface.
- [admin-ui.md](admin-ui.md) — navigation (Rule zero), embedding, theme,
  phone.
- [phases.md](phases.md) — waves, exclusive path ownership, acceptance
  criteria, tests.
- [decisions.md](decisions.md) — the Phase 0 spike record: measured engine
  facts, the corrections they force on this plan, and the owner's calls.
- [spike-b-xlsx.md](spike-b-xlsx.md) — xlsx and CSV fidelity measurements.
- [spike-cd-render-touch.md](spike-cd-render-touch.md) — the admin render
  and phone-touch spikes.

## Goal

A spreadsheet is a first-class document in the knowledge base: a person
creates one where they create any document, edits it in the admin with a
real grid (formulas, formatting, sheets, sorting, filters, merges), sees
everybody else in it live — selection, cursor, what they are typing before
they commit — and agents work in the same document through a full tool set,
visibly, as if they were another person at the table.

## Decisions (each argued in the linked file)

1. **Library: IronCalc — `@ironcalc/workbook` (React UI), `@ironcalc/wasm`
   (browser engine), `@ironcalc/nodejs` (server engine), one exact version
   pinned on all three (`SPREADSHEET_ENGINE_VERSION`), not forked.** MIT /
   Apache-2.0, React 18/19, real theme variables incl. a dark theme, 496
   functions, xlsx in and out, prebuilt Node binaries for every deploy
   target. Two people carry the project; its own docs say collaboration is
   not shipped. We use its diff protocol and add the ordering.
   → `library-assessment.md`
2. **The canonical state is the IronCalc workbook itself** — engine bytes
   (`toBytes()`) plus an **ordered journal of engine diffs**
   (`spreadsheet_op_batches.diffs` = `flushSendQueue()` payloads, per-page
   `seq`). Cell-level SQL rows are gone: the engine holds, evaluates and
   reads cells; a second copy would be a second authority.
   → `storage-and-concurrency.md`
3. **Durable versions are `.xlsx` renditions** on `KnowledgePageVersion`
   (attachment through `FileService`, text projection in `body`,
   `sourceContentHash`), with the engine bytes kept beside them for fast
   loads. The bitcode format is version-coupled and undecodable outside the
   exact crate version; a person's spreadsheet must outlive an engine bump,
   so xlsx is the format of record and an engine bump is a data migration.
   → `storage-and-concurrency.md`
4. **The server is the canonical model; the browser is an optimistic
   replica.** Every write — browser, worker tool, MCP — goes through
   `applySpreadsheetBatch`: per-page advisory lock, a per-process model cache
   fast-forwarded from the journal, `pauseEvaluation → applyExternalDiffs →
   evaluate`, `seq` assignment, audit row, publish after commit. Server-side
   recalculation is the same engine the browser runs, so there is no
   cross-engine drift to worry about. → `storage-and-concurrency.md`
5. **Concurrency: server order, cell-level last-writer-wins (no cell
   locks — live presence makes a collision visible, as in Google Sheets),
   structural refusal, rebase by replaying intent.** IronCalc diffs are absolute and
   sheet-index-addressed; applying the same diffs in different orders
   diverges (measured), so the journal's order is the truth. A browser batch
   that crossed a structural batch on the same sheet is refused; because the
   bytes cannot be transformed, the client undoes its pending actions,
   applies the foreign batches, and re-issues the **method calls it
   recorded** with shifted indexes. No CRDT. → `realtime-and-presence.md`
6. **Transport is a new per-document SSE lane** (`GET
   /pages/:pageId/live`), ephemeral NOTIFY only, new envelope kind
   `document` with `scopes: []` (inert to previous-build replicas); ops are
   recoverable by `seq`, presence is not and need not be. Not the WS lane
   (`filterAuthorizedScopes` treats unknown kinds as `agent`; old replicas
   reject a whole subscribe frame). → `realtime-and-presence.md`
7. **Presence is stateless on the server**; frames carry sheet index,
   selection, cursor and ≤ 256 chars of in-cell draft; joiners trigger a
   re-announce; agents publish the same frames from the worker with their
   identity and colour. → `realtime-and-presence.md`
8. **One write door** in `@nessie/knowledge`, `@ironcalc/nodejs` loaded in
   both the API and the worker, one model cache per process (closure state,
   LRU by bytes, always fast-forwarded under the lock). → `storage-and-concurrency.md`
9. **Twelve tools under a new `spreadsheets` category, mirrored 1:1 as
   `nessie_sheet_*`.** A1 ranges and sheet names on the wire, 1-based
   IronCalc addressing underneath; batch-first; idempotent on
   `toolCallId`; reads capped at 10 000 cells; server batches built at head
   under the lock so they never conflict; **no approval gate — versioning is
   the safety net**: every destructive write snapshots a named version and
   `sheet_versions` lists and restores. Sort, filter and find/replace —
   absent from IronCalc — are full-fidelity Nessie implementations over the
   engine (sort keeps formula meaning under Excel/Sheets copy semantics via
   `getTokens`; a persisted per-sheet filter model applied as engine row
   hiding; find/replace across sheets). → `agent-tools.md`, `storage-and-concurrency.md`
10. **UI: wrap, do not fork.** One `pnpm patch` (≈ 20 lines) adds
    `redraw()` to `IronCalcHandle`; everything else is done from outside —
    own-property wrappers on the wasm `Model` instance (intent recording,
    flush, selection frames), a delegated `input` listener on the editor
    textarea (drafts), our own presence overlay, our own action bar for
    sort/filter/find/history/export, `themeVariables` from admin tokens.
    Navigation is unchanged: a spreadsheet is a page kind in the one
    knowledge workspace. **Phones get full editing** — IronCalc already
    edits on touch; the one missing piece, range selection by touch, is
    added in our overlay. → `admin-ui.md`

## Architecture

```text
 admin (React 19)                                    api replica N                 worker replica M
 ┌────────────────────────────────────┐  bootstrap    ┌────────────────────────┐    ┌──────────────────────────┐
 │ SpreadsheetPane                    │ ──GET───────▶ │ knowledge-spreadsheet  │    │ sheet_* builtin tools    │
 │  ├ <IronCalc model> (wasm Model)   │  {bytes,      │ routes                 │    │  ├ model cache (nodejs)  │
 │  │   shadowed mutators ─▶ intents  │   batches}    │  ├ model cache (nodejs)│    │  └ applySpreadsheetBatch │
 │  │   flushSendQueue ─▶ POST ops ───┼─────────────▶ │  └ applySpreadsheetBatch│   │     (same function)      │
 │  │   applyExternalDiffs ◀ batches  │ ◀─ack {seq}── │     (one write door)   │    │ presence frames (agent)  │
 │  ├ PresenceOverlay + draft observer│ ─POST presence│ presence ingress       │    └────────────┬─────────────┘
 │  ├ action bar (sort/filter/find…)  │               └───────────┬────────────┘                 │
 │  └ VersionHistory (existing)       │                           │ NOTIFY nessie_realtime {kind:'document', scopes:[]}
 └──────────────▲─────────────────────┘                           ▼
                └── SSE /pages/:id/live ─────────────  realtime hub (document lane, per-event entitlement)

 Postgres: knowledge_pages(kind=spreadsheet) · spreadsheet_heads(hot_snapshot bytes, engine_version, head_seq)
           spreadsheet_op_batches(seq, diffs bytes, summary) · knowledge_page_versions(attachment = .xlsx, body = text)
 @nessie/spreadsheet (small): a1 · read · write · sort · filter · projection · rebase(shiftIntent) · csv · node(xlsx)
```

## What changed from the FortuneSheet draft

| Area | FortuneSheet draft | IronCalc contract |
|---|---|---|
| Canonical state | cell rows + JSON op journal + our own applier | engine bytes + engine diff journal; engine applies |
| Server engine | hand-written formula engine on a parser; parity risk | the same Rust engine on both sides; drift question dropped |
| Versions | workbook JSON snapshot | xlsx rendition (durable) + `.icalc` bytes (fast) |
| Rebase | transform JSON ops | replay recorded intents (bytes are opaque) |
| Batch metadata | derived by the server from ops | caller-supplied summary (bytes are opaque); upstream `summarize_diffs` proposed |
| Theme | 3.3k-line CSS bridge, light grid island in dark mode | `themeVariables` + `darkThemeVariables`, canvas follows |
| Sort/filter/find | library toolbar (sort, filter, search) | full-fidelity Nessie layer: reference-preserving sort, persisted filter model, workbook find/replace |
| Engine upgrade | not a concern (JSON) | a simple per-page migration through xlsx (greenfield: no compatibility machinery) |
| Bundle | ~1 MB JS | ~0.9 MB JS + 1.9 MB wasm (lazy) |

Kept: the per-document SSE lane, the inert `document` kind, stateless
presence including agents, the single write door, the ten-tool surface, the
navigation decisions, the phases and their exclusive paths.

## Phases

| Phase | Owner wave | What lands | Depends on |
|---|---|---|---|
| 0 Contract & spikes | orchestrator | schemas, Prisma migration, engine interface, the `redraw` patch, three spikes (engine pair, xlsx, render), decision record, upstream PRs | — |
| 1 Engine adapter | wave A | `packages/spreadsheet` (a1, read, write, sort, filter, projection, rebase, csv, node/xlsx) | 0 |
| 2 Persistence, API, live lane | wave A | write door + model cache, routes, SSE lane, hub connection kind, realtime schemas, audit, engine-migrate | 0 |
| 3a UI shell | wave A | pane, IronCalc embedding, model bridge, theme, doorways, history, import/export, sort/filter/find dialogs | 0 |
| 3b Live UI | wave B | op sync client with intent replay, presence overlay, draft observer, two-browser e2e | 1, 2, 3a |
| 4 Agent tools | wave B | worker builtins + MCP mirror + agent presence + prompt block + disclosure | 1, 2 |
| 5 Hardening & docs | wave C | sweeps, engine-migrate driver, multi-instance case, standards file, AGENTS.md routing, CLAUDE.md e2e line, CI step | 3b, 4 |

Detailed per-phase ownership and acceptance criteria: `phases.md`.

## Exclusive path ownership (summary)

| Paths | Phase |
|---|---|
| `packages/schemas/src/spreadsheet.ts`, `realtime-document.ts`, `tool-categories.ts`; `api/prisma/schema.prisma` (+migration); `packages/spreadsheet/` skeleton; `patches/@ironcalc__workbook*.patch`; dependency pins; `docs/plans/2026-09-15-spreadsheets-ironcalc/**` | 0 |
| `packages/spreadsheet/src/**`, `packages/spreadsheet/test/**` | 1 |
| `packages/knowledge/src/spreadsheet/**`, `api/src/routes/knowledge-spreadsheet*.ts`, `api/src/realtime/document-lane.ts`, `packages/runtime/src/realtime*.ts` (document envelope), `api/test/spreadsheet-*.test.ts`, `worker/src/control/spreadsheet-compact.ts` | 2 |
| `admin/src/components/features/knowledge/spreadsheet/**` (except `live/**`), `admin/src/facades/knowledge/spreadsheet-hooks.ts`, the kind-switch sites listed in `admin-ui.md` | 3a |
| `admin/src/components/features/knowledge/spreadsheet/live/**`, `admin/src/facades/knowledge/spreadsheet-live.ts`, `admin/e2e/spreadsheets/**` | 3b |
| `packages/runtime/src/builtin-sheet-tools.ts`, `worker/src/run/pa-tools/spreadsheet*.ts`, `worker/src/run/sheet-tool-dispatch.ts`, `api/src/mcp/tools/spreadsheets.ts`, `worker/src/run/execute/agent-documents.ts`, `worker/test/db/spreadsheet-*.test.ts` | 4 |
| `worker/src/control/spreadsheet-sweeps.ts`, `docs/standards/spreadsheets.md`, `AGENTS.md`, `CLAUDE.md`, `docs/knowledge-base-requirements.md` §9e, `.github/workflows/ci.yml` | 5 |

Shared files nobody in a wave may touch without the orchestrator:
`packages/runtime/src/builtin-tools.ts` (Phase 4 only),
`api/src/realtime/notification-delivery.ts` and `hub.ts` (Phase 2 only),
`api/src/register-api-routes.ts` (Phase 2 only), `admin/package.json` and
the lockfile (Phase 0 only).

## Settled decisions (owner, 2026-09-16)

1. **Concurrent cell edits:** Google Sheets behaviour — no locking,
   server-ordered last-write-wins, live presence makes a collision visible.
   No cell locks, now or as an option.
2. **Batch summary:** keep the client-reported summary, **advisory only** —
   never an input to authorization, tenancy or permission decisions; a
   wrong or hostile summary costs at most a rebase. Stated in
   `storage-and-concurrency.md` with a dedicated test
   (`spreadsheet-summary-advisory.test.ts`). Revisit when upstream
   `summarize_diffs` lands.
3. **Destructive agent writes:** versioning, not an approval gate. A named
   version before every destructive structural op (and at an agent run's
   first write), restore first-class in the UI (History → Restore, the
   post-snapshot notice, chat tool cards) and in the tools
   (`sheet_versions list|save|restore`). What a version captures and when
   automatic ones fire: `storage-and-concurrency.md` §"Version history is
   the safety net".
4. **Engine upgrades:** data migrations with one pinned IronCalc version
   across API, worker and browser — accepted; no backwards-compatibility
   machinery for data that does not exist; the migration driver stays one
   simple job (`storage-and-concurrency.md` §"Engine upgrades").
5. **Stream CORS on tenant hosts:** already fixed on `main` by PR #501
   (`events.ts`, `thread-stream.ts`, `designer.ts`, `server-origin-policy.ts`);
   what this branch saw was staleness. The branch rebases onto `main` before
   Phase 1. `mcp-endpoint.ts` still passes no CORS headers on `main`, and
   that is **correct** for its non-browser MCP clients
   (`realtime-and-presence.md` §"Realtime kinds added" states why; Phase 5
   adds the sentence to `paired-agents.md`).
6. **Mobile:** IronCalc edits on phones (verified in source and on the live
   app); Nessie supports editing, adding touch range selection and handles
   in its overlay. View-only is never device-driven.
7. **Sort/filter/find:** the best full experience — reference-preserving
   sort, a real persisted per-sheet filter model visible to agents,
   find/replace across sheets — all in Nessie's layer over the engine, with
   three upstream contributions proposed (`extend_to` exposure, Node paste
   key fix, engine autofilter). Cost and split: `storage-and-concurrency.md`
   §"Sort, filter, find and replace".
8. **Bundle:** ~0.9 MB JS + 1.9 MB wasm, lazily loaded — accepted.

## Remaining unknowns (genuinely new)

- **Touch selection ergonomics.** Spike D decides whether long-press-drag
  fights the native scroll on iOS WebKit; the fallback is a "Select" mode
  toggle in the action bar rather than a gesture.

Two former unknowns are settled (owner, 2026-09-16):

- **Version-storage growth: not a concern now.** Automatic snapshots keep
  firing and storage grows; there is no retention policy and Phase 5 must
  not build one. Revisit when there is real usage to measure.
- **Cross-sheet references in a sort: follow Sheets.** The standing rule for
  every behavioural question in this build is *do what Google Sheets does*.
  Where this plan offered a cheaper deviation, the Sheets behaviour wins;
  where Sheets' behaviour is unknown to the implementer, check it in Sheets
  before choosing, and record the answer in `decisions.md`.
