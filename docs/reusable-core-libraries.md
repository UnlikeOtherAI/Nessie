# Reusable Core Libraries for Nessie

> **Status**: proposal/research note, not an active implementation spec.

## Bottom Line

There is no existing C or C++ library in this repo that can be lifted out
and reused as-is.

What exists today is:

- a TypeScript service under `src/` that owns most of the current
  orchestration, persistence, tool, and provider logic
- a Go control-server scaffold under `remote/` that is a separate service and
  not part of the current app-parity problem
- a macOS Swift client with meaningful app-state and protocol logic that
  should not be reimplemented separately on every platform

If the goal is parity across iOS, Android, macOS, Windows, and Linux, the
correct split is two reusable cores:

- `nessie-app-core`
  A C++ library for native app behavior that must stay identical across
  platforms.
- `nessie-runtime-core`
  A TypeScript library for the API and CLI runtime.

The app core should be C++ because that is the practical way to share logic
between Apple, Android, Windows, and Linux native clients.

The API and CLI core should stay TypeScript unless there is a very strong
reason to force it into C++. Node is already cross-platform, and the current
runtime logic in `src/` already exists in TypeScript.

## What Exists Today

### App-side logic that looks extractable

These files contain app behavior that should not stay macOS-only:

- `macos/Nessie/App.swift`
  App state, event handling, session derivation, streaming assembly, and
  selection behavior.
- `macos/Nessie/NessieClient.swift`
  HTTP, SSE, and WebSocket client protocol handling.
- `macos/Nessie/Models.swift`
  Client-side domain models.
- `macos/Nessie/VoiceModeView.swift`
  Voice session flow and backend voice event handling. The current
  implementation is incomplete, but the state-machine-shaped parts are real
  extraction candidates.

This is the main source material for a future app core.

### Server-side logic that belongs in a runtime core

These modules are reusable, but they belong to the backend and CLI side, not
to the native app library:

- `src/agent/Orchestrator.ts`
- `src/agent/types.ts`
- `src/db/database.ts`
- `src/engine/compression.ts`
- `src/mcp/server.ts`
- `src/mcp/adapter.ts`
- `src/llm/client.ts`
- `src/llm/streaming.ts`
- `src/tools/*.ts`
- `src/index.ts`

This code is already multi-platform by virtue of running on Node. It should be
modularized, but not pushed into the app C++ core.

The Go code under `remote/` is a separate concern. Right now it is a scaffold
service with health and readiness endpoints, not a reusable logic layer for
either the app core or the TypeScript runtime core.

### Host-specific code that should stay out of shared core

- SwiftUI and AppKit view code in `macos/Nessie/*.swift`
- AVFoundation microphone and playback integration
- Apple speech and hotword integration
- `URLSession`, `NWPathMonitor`, menu bar, windows, and accessibility wrappers
- backend HTTP server hosting in `src/index.ts`
- shell, file, and system tool implementations in `src/tools/*`

## Recommended Architecture

### `nessie-app-core` in C++

#### App Purpose

This library exists to keep app behavior identical across native clients.

It should own:

- canonical client domain models
- protocol event parsing and reduction into app state
- session and thread derivation rules
- streaming response assembly
- local persistence models and storage interfaces
- sync state and retry queue logic
- voice turn and session state machines
- configuration and feature flags for client behavior
- serialization for snapshots, cached messages, and sync payloads

It should not own:

- UI
- platform networking stacks
- platform audio stacks
- OS permissions
- backend orchestration
- MCP server behavior
- shell and file access tools
- direct provider-specific LLM code

#### What should move into it from the current app

##### Canonical models

The current app has parallel client models in `macos/Nessie/Models.swift` and
matching event and data contracts in `macos/Nessie/NessieClient.swift` and
`src/events.ts`.

Those should become one shared model set:

- `Agent`
- `Message`
- `Session`
- `SubAgentSummary`
- `ToolCallEntry`
- `StreamingRun`
- `ConnectionState`
- `VoiceState`

##### App state reducer

The most important reusable logic currently lives in `AppState` inside
`macos/Nessie/App.swift`.

That reducer-like behavior should move into the C++ core:

- apply full remote state snapshots
- apply incremental events
- deduplicate incoming messages
- track the active streaming run
- append streaming deltas
- clear stream state on completion or error
- track active sub-agents
- track tool call lifecycle
- maintain selected session and selected agent

That is exactly the type of logic that otherwise drifts between Swift, Kotlin,
C#, and Linux desktop clients.

##### Session derivation and naming

The current session list is rebuilt from messages in
`AppState.syncSessions()`, and names come from
`sessionName(for:messages:)`.

Those rules should be shared. If one platform groups, sorts, names, or
previews threads differently, the product starts to diverge immediately.

##### Stream assembly

The current app assembles partial assistant output from `streaming.start`,
`streaming.delta`, and `streaming.done`.

That should be core behavior, not UI behavior.

The UI should only render:

- committed messages
- the current in-flight stream buffer
- thinking, speaking, and listening flags

##### Local storage layer

The macOS app currently depends on backend state and does not own serious local
persistence.

That is a gap, not an asset.

The app core should define:

- message store
- session store
- sync cursor store
- pending outbound queue
- cached settings and config store

The implementation can use SQLite underneath, but the library should expose
storage interfaces that each host binds to one SQLite-backed implementation.

##### Voice session state machine

The current voice code in `macos/Nessie/VoiceModeView.swift` mixes:

- UI state
- AVFoundation
- WebSocket handling
- voice session lifecycle

Only the lifecycle and state-machine part belongs in shared core.

The C++ core should own:

- idle, listening, transcribing, responding, and error states
- session start and stop transitions
- timeout and retry rules
- transcript accumulation
- response text accumulation
- audio-level smoothing inputs

The hosts should own:

- microphone capture
- playback
- permissions
- the actual transport adapter

##### Sync engine

The app currently fetches state and consumes SSE and WebSocket events directly
from Swift.

That should be moved behind a core sync API:

- connect
- disconnect
- fetch snapshot
- apply normalized stream events
- reconnect and backoff policy
- de-duplication and idempotency rules

The actual HTTP and socket implementations should remain host adapters.

#### What is not ready to extract yet

There is not enough app-side business logic in the repo to pretend that this
is already a mature portable core.

Right now, the future C++ library is mostly an extraction target, not an
existing reusable asset.

That is because:

- local persistence is barely app-owned today
- the app is a thin backend client
- voice is incomplete
- transport and event handling are spread across Swift and TypeScript
- there is no current native core layer to port

So this effort is not just extraction. It is also redesign.

### `nessie-runtime-core` in TypeScript

#### Runtime Purpose

This library should hold the TypeScript service and CLI domain logic that is
already multi-platform under Node.

It should own:

- orchestrator state and behavior
- tool abstractions
- MCP model and adapters
- message history and memory compression logic
- provider-neutral LLM interfaces
- runtime event models
- reusable API and CLI service functions

It should not own:

- raw HTTP server setup
- raw CLI process entrypoints
- app UI concerns
- the Go `remote/` service, unless that service later grows a real reusable
  TypeScript-compatible domain layer of its own

#### What should move into it from the current server

- `src/agent/*`
- `src/db/database.ts`
- `src/engine/compression.ts`
- `src/mcp/*`
- `src/events.ts`
- `src/llm/*`

The entrypoints should become thin shells:

- API host
- CLI host
- future daemon host

The Go service in `remote/` should be treated separately. Based on the current
repo, it is best described as an adjacent service scaffold, not as an input to
the `nessie-runtime-core` extraction plan.

#### Why this should stay TypeScript

- it already runs everywhere Node runs
- it already depends on Node and Bun APIs
- the operational environment for API and CLI is not the same as native app
  embedding
- forcing it into C++ would add complexity without solving the parity problem
  the apps actually have

## Shared Contract Between the Two Libraries

If there are two libraries, there must be one source of truth for the protocol
between them.

That contract should define:

- event names
- wire payloads
- session, message, tool, and agent schemas
- versioning rules
- compatibility behavior for unknown fields

Today those shapes are duplicated across:

- `src/events.ts`
- `macos/Nessie/NessieClient.swift`
- `macos/Nessie/Models.swift`

That duplication is where drift begins.

This can be solved in one of two ways:

1. a small third artifact such as `nessie-protocol`
2. generated code from one schema source consumed by both libraries

The right answer is schema-first, even if the product plan is still
"two libraries."

## What the App C++ Core Should Look Like

### Public Surface

The public boundary should be a C API over an internal C++ implementation.

Reason:

- Swift interoperates cleanly with C and Objective-C++, not with arbitrary
  modern C++ APIs
- Android will want JNI wrappers
- Windows app stacks will want either a C ABI or C++ bindings adapted for that
  host stack
- Linux desktop clients are simpler with a plain C ABI

So the structure should be:

- internal C++ domain engine
- stable C ABI facade
- thin platform bindings per host

### Proposed Modules

#### `core/model`

- message
- session
- agent
- tool call
- connection state
- voice state

#### `core/reducer`

- apply snapshot
- apply event
- derive visible state
- derive session summaries

#### `core/storage`

- storage interfaces
- SQLite-backed implementation
- migrations

#### `core/sync`

- transport-neutral sync client
- reconnect policy
- outbound action queue
- cursor tracking

#### `core/voice`

- voice session state machine
- transcript buffer
- response buffer
- audio-level smoothing and thresholds

#### `core/config`

- environment-independent config model
- feature flags
- endpoint config

#### `core/serialization`

- JSON encode and decode
- schema versioning
- import and export of cached state

## What to Keep out of `nessie-app-core`

Do not put these in the shared app library:

- SwiftUI, Jetpack Compose, WinUI, Qt, or other widget trees
- microphone APIs
- speaker and output APIs
- HTTP client implementation details
- WebSocket stack implementation details
- SSE parsing tied directly to one platform runtime
- backend orchestration and agent planning
- shell tools
- filesystem mutation tools
- LLM provider SDK code

The app core should describe behavior, not absorb every dependency.

## What We Can Realistically Extract First

Phase 1 should be small and high leverage.

### First extraction slice

- event model
- app state reducer
- streaming accumulator
- session derivation and naming rules
- tool activity tracker
- selected session and agent behavior

This is the lowest-risk slice because it already exists conceptually in
`macos/Nessie/App.swift`.

### Second extraction slice

- local SQLite store
- sync cursors
- outbound message queue
- reconnect policy

### Third extraction slice

- voice session state machine
- transport-neutral voice protocol handling

## What We Cannot Honestly Claim Yet

We cannot honestly say that all business logic already exists in a form ready
to move into C++.

The repo does not currently have:

- a mature app-side domain layer
- shared native core primitives
- stable schema ownership
- app-owned persistence equivalent to the server persistence
- complete voice logic

So this effort is not just extraction. It is also redesign.

## Proposed Repository Layout

```text
core/
  app/
    include/nessie/
    src/
    tests/
    c_api/
  runtime/
    src/
    tests/
  protocol/
    schema/
    generated/
bindings/
  apple/
  android/
  windows/
  linux/
apps/
  macos/
  ios/
  android/
  windows/
  linux/
services/
  api/
  cli/
```

## Recommended Decision

Build two reusable cores, not one:

- `nessie-app-core` in C++
  This is the parity engine for native apps.
- `nessie-runtime-core` in TypeScript
  This is the reusable backend and CLI engine.

Put one shared protocol contract between them.

That is the smallest architecture that matches the codebase we actually have.

Trying to force both worlds into one library would mix native app concerns
with backend runtime concerns and make both worse.

## Immediate Next Step

Do not start by porting UI or audio code.

Start by extracting the reducer contract from the current macOS app:

- snapshot model
- event model
- reducer
- session derivation
- streaming state

If that extraction is clean, the C++ app core is justified.

If that extraction is messy, it identifies exactly which contract needs to be
cleaned before bringing in Android, iOS, Windows, or Linux.
