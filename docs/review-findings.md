# Nessie Code Review — Validated Findings

**Validated by:** manual source inspection, targeted Gemini CLI pass, targeted Claude CLI pass  
**External checks:** OpenAI Realtime docs, MCP 2025-11-25 transport spec, `pnpm audit --prod`  
**Date:** 2026-04-06  
**Scope:** current working tree only

## Executive Summary

The original report found several real problems, but it also mixed in protocol misreads, speculative runtime behavior, duplicate items, and roadmap gaps. The result was noisy. The biggest real issues are still serious:

1. `/mcp` is an unauthenticated admin surface with direct access to dangerous tools.
2. The tool layer allows unrestricted shell execution and unrestricted file read/write.
3. Live secrets are present in the local `.env`.
4. The voice path is not wired end-to-end.
5. The MCP implementation is incomplete and partially non-compliant, but most of those defects are not critical.

The goal of this rewrite is to keep only defensible findings and explicitly red-flag the ones that should not survive another review unchanged.

## Confirmed Findings

### 1. `/mcp` is effectively an unauthenticated local admin endpoint
**Original IDs:** C-1, M-10, M-11, M-12  
**Verdict:** keep

`src/index.ts` exposes `GET /mcp` and `POST /mcp` with no authentication, no origin validation, and no access control on tool visibility ([src/index.ts](../src/index.ts), [src/mcp/server.ts](../src/mcp/server.ts), [src/mcp/adapter.ts](../src/mcp/adapter.ts)). The MCP layer can invoke the full tool registry, inject messages, and write screenshots to arbitrary paths. This is the single most important issue in the report.

### 2. Dangerous tool implementations are real, not hypothetical
**Original IDs:** C-2, C-3, C-4, C-5  
**Verdict:** keep

- `BashTool` passes arbitrary command strings to `exec`, which means shell evaluation through `/bin/sh` ([src/tools/BashTool.ts](../src/tools/BashTool.ts)).
- `FileReadTool` reads any path supplied by the caller ([src/tools/FileReadTool.ts](../src/tools/FileReadTool.ts)).
- `FileWriteTool` writes any path supplied by the caller ([src/tools/FileWriteTool.ts](../src/tools/FileWriteTool.ts)).
- `GrepTool` interpolates user input into a shell command string and is command-injectable ([src/tools/GrepTool.ts](../src/tools/GrepTool.ts)).

These issues were correctly identified and should remain top priority.

### 3. Live secrets are present on disk
**Original IDs:** C-20  
**Verdict:** keep, but reword

The local `.env` contains live-looking API keys. What is defensible from the current repo state is: the secrets exist on disk, `.env` is ignored, and they should be rotated. What is **not** verified here is any claim that they were committed to git history. `git ls-files .env` returns nothing, so the report should not assert that without separate history verification.

### 4. The voice path is not wired end-to-end
**Original IDs:** C-6, C-7, C-8, C-9, H-5, H-8, H-10, H-11  
**Verdict:** keep, with tighter wording

This part of the report is directionally right:

- `RealtimeClient` defaults to `gpt-realtime-1.5`, and `src/index.ts` also hardcodes that model name ([src/voice/RealtimeClient.ts](../src/voice/RealtimeClient.ts), [src/index.ts](../src/index.ts)).
- `RealtimeClient.sendAudio()` exists but has no callers.
- `VoiceBridge` captures mic audio, but only stores `pendingLevel`; it never transmits PCM to the backend ([macos/Nessie/VoiceModeView.swift](../macos/Nessie/VoiceModeView.swift)).
- The backend `/voice` websocket ignores `audio_level` and only processes text transcripts ([src/index.ts](../src/index.ts)).
- `VoiceManager` is effectively dead stub code ([macos/Nessie/VoiceManager.swift](../macos/Nessie/VoiceManager.swift)).
- `VoiceBridge` hardcodes `ws://127.0.0.1:4317/voice`, and `StatusPanel` hardcodes the same backend address instead of using shared config ([macos/Nessie/VoiceModeView.swift](../macos/Nessie/VoiceModeView.swift), [macos/Nessie/StatusPanel.swift](../macos/Nessie/StatusPanel.swift)).
- `NessieClient` declares `wsContinuation` but never uses it, and `disconnectWebSocket()` nils `wsReceiveTask` twice ([macos/Nessie/NessieClient.swift](../macos/Nessie/NessieClient.swift)).

The broad conclusion should be: voice mode is incomplete and currently non-functional as a true audio pipeline.

### 5. `voiceClient` lifecycle ownership is wrong
**Original IDs:** C-8, C-9  
**Verdict:** keep, but reword

`voiceClient` is constructed as a local constant inside `main()` and is never stored anywhere reachable by shutdown logic ([src/index.ts](../src/index.ts)). That means the code has no reliable way to disconnect or manage it later. The original report's garbage-collection explanation was wrong; the ownership/shutdown problem is still real.

### 6. MCP / JSON-RPC compliance is incomplete
**Original IDs:** C-12, C-14, C-15, C-19, H-15, H-16, H-17  
**Verdict:** keep, but downgrade severity

The implementation has real protocol gaps:

- `GET /mcp` returns a JSON manifest instead of SSE or `405 Method Not Allowed` ([src/index.ts](../src/index.ts)).
- `notifications/initialized` returns a JSON-RPC response, which is wrong for a notification ([src/mcp/server.ts](../src/mcp/server.ts)).
- `initialize` advertises `protocolVersion: '2024-11-05'` and stale `serverInfo.name` ([src/mcp/server.ts](../src/mcp/server.ts)).
- Request handling ignores `MCP-Protocol-Version` entirely ([src/index.ts](../src/index.ts)).
- Generic exceptions collapse to `-32603` ([src/mcp/server.ts](../src/mcp/server.ts)).
- `AbortController` instances are created but not wired to any timeout or cancellation path ([src/mcp/adapter.ts](../src/mcp/adapter.ts), [src/agent/Orchestrator.ts](../src/agent/Orchestrator.ts)).
- Request bodies are accumulated without any size limit in the HTTP handlers ([src/index.ts](../src/index.ts)).

These are genuine implementation problems. They are mostly **compatibility and robustness issues**, not critical remote-compromise findings.

### 7. Naming and documentation drift are real
**Original IDs:** H-19, M-21, D-1, D-2  
**Verdict:** keep

The codebase still contains multiple `helper` remnants:

- package name `helper-agent` ([package.json](../package.json))
- stale env vars such as `HELPER_HOST`, `HELPER_PORT`, `HELPER_DB_PATH`, `HELPER_WEATHER_QUERY` ([src/index.ts](../src/index.ts), [src/db/database.ts](../src/db/database.ts), [src/agent/Orchestrator.ts](../src/agent/Orchestrator.ts))
- stale MCP resource URIs `helper://...` and screenshot path `/tmp/helper-screenshot.png` ([src/mcp/server.ts](../src/mcp/server.ts))
- stale user-facing string `"helper backend"` ([macos/Nessie/NessieClient.swift](../macos/Nessie/NessieClient.swift))

`CLAUDE.md` is also internally contradictory: it mentions both `gpt-realtime-1.5` and `gpt-4o-realtime-preview`, and documents a `stream_audio` capability that the server does not expose ([CLAUDE.md](../CLAUDE.md)).

### 8. `WebSearchTool` is a placeholder, not real search
**Original IDs:** M-7  
**Verdict:** keep

`WebSearchTool` returns a fabricated result object pointing the user to DuckDuckGo rather than performing search ([src/tools/WebSearchTool.ts](../src/tools/WebSearchTool.ts)). That should be described as a placeholder or stub, not an implemented tool.

### 9. Keyboard injection is still unimplemented
**Original IDs:** H-21  
**Verdict:** keep

`Orchestrator.handleKeyboardInject()` calls an optional callback, but `src/index.ts` never supplies one ([src/agent/Orchestrator.ts](../src/agent/Orchestrator.ts), [src/index.ts](../src/index.ts)). The documented keyboard mode is not present end-to-end.

### 10. The remote Go control server is scaffold-level
**Original IDs:** M-1, M-3, M-8  
**Verdict:** keep, but lower severity

The remote server binds plain HTTP, defaults to `:8787`, and the example Postgres URL uses `sslmode=disable` ([remote/cmd/control-server/main.go](../remote/cmd/control-server/main.go), [remote/.env.example](../remote/.env.example)). These are fair observations, but the server currently exposes only `/healthz` and `/readyz`, so this should not be presented like a completed privileged control plane with missing production controls.

## Findings That Need Downgrade or Removal

### 1. `MCP-Session-Id` is **not** mandatory by default
**Original ID:** C-13  
**Verdict:** remove

The current MCP transport spec says a server using Streamable HTTP **may** assign a session ID at initialization. If it returns one, the client must send it later. That is different from "required and missing". This claim should not remain in the document as written.

### 2. `connectWebSocket()` does not "yield nothing"
**Original ID:** C-16  
**Verdict:** remove, keep only the dead-code cleanup issue

`wsContinuation` is unused, but the `AsyncStream` continuation passed into `wsReceiveLoop()` is still the one receiving yielded events. The stream works. The real issue is dead code and the typo in `disconnectWebSocket()`, not a broken websocket stream.

### 3. `Promise.all` does not reorder batch responses
**Original ID:** M-16  
**Verdict:** remove

`Promise.all()` preserves input order in its result array. This is not a valid finding.

### 4. `transcriptBuffer` is not shared across voice sessions
**Original ID:** M-17  
**Verdict:** remove

`transcriptBuffer` is declared inside `handleVoiceWebSocket()`, so it is per websocket connection, not module-global shared state ([src/index.ts](../src/index.ts)).

### 5. The original C-8 explanation was wrong
**Original ID:** C-8  
**Verdict:** rephrase

The issue is not block scoping or "immediate GC". The issue is missing ownership and missing shutdown/disconnect.

### 6. The SSE claim was overstated
**Original ID:** C-12  
**Verdict:** rephrase

Current MCP transport allows a POST request to return either `application/json` or `text/event-stream`. The obvious violation in this codebase is `GET /mcp`, which returns a JSON tool manifest instead of SSE or `405`. Keep the compliance finding, but fix the rationale.

### 7. The "crash on SSE write error" claim is too strong
**Original ID:** C-11  
**Verdict:** downgrade

The code definitely lacks disconnect handling for SSE streams and keeps no `close` listener on the response. What is not proven from inspection alone is that `res.write()` will reliably crash the handler exactly as described. Reword this as missing disconnect cleanup / brittle stream handling.

### 8. The Swift race-condition findings are not well-supported
**Original IDs:** C-17, C-18  
**Verdict:** remove

The underlying Swift code is weak and partly stubbed, but the specific data-race claims are not convincingly established from the code shown. `VoiceManager` being a dead stub and `VoiceBridge` not actually sending audio are stronger, cleaner findings.

### 9. Sample-rate and interruption findings are misprioritized
**Original IDs:** H-12, H-13  
**Verdict:** remove

Right now no PCM is transmitted at all, so sample-rate mismatch is not the active blocker. The interruption finding also leans on `AVAudioSession` framing that does not match the current macOS code. Keep focus on the missing transport, not hypothetical next-order bugs.

### 10. The `session.update` sequencing claim is unsupported
**Original ID:** H-23  
**Verdict:** remove

The docs show `session.created` before prompt updates in examples, but this report does not prove that sending `session.update` from `onopen` is rejected or broken in practice.

### 11. The sandbox/notarization statement overreaches
**Original ID:** H-7  
**Verdict:** downgrade

`com.apple.security.app-sandbox` is disabled, which is a valid security posture concern. "No notarization will pass" is not established by this review and should be removed.

### 12. The `bonjour` vulnerability claim is unverified
**Original ID:** H-1  
**Verdict:** remove until cited

`pnpm audit --prod` reported zero advisories for the current lockfile. If there is a specific advisory or CVE relevant to this exact dependency set, it should be cited explicitly before being kept.

### 13. Several remote-server items are premature
**Original IDs:** M-4, M-5, M-6  
**Verdict:** downgrade heavily or remove

Those findings describe missing auth, rate limiting, and CORS scaffolding on a server that currently exposes only health endpoints. They are future hardening notes, not strong current defects.

## Valid Missing or Underplayed Items

These should stay in the report because they are real and easy to verify:

1. `HELPER_WEATHER_QUERY` is still stale ([src/agent/Orchestrator.ts](../src/agent/Orchestrator.ts)).
2. MCP resource URIs still use `helper://...` ([src/mcp/server.ts](../src/mcp/server.ts)).
3. Screenshot temp path still uses `/tmp/helper-screenshot.png` ([src/mcp/server.ts](../src/mcp/server.ts)).
4. `hotwordActive` is hardcoded to `false` in both MCP adapter and orchestrator tool context ([src/mcp/adapter.ts](../src/mcp/adapter.ts), [src/agent/Orchestrator.ts](../src/agent/Orchestrator.ts)).
5. `CLAUDE.md` documents `stream_audio`, but the MCP server does not expose it ([CLAUDE.md](../CLAUDE.md), [src/mcp/server.ts](../src/mcp/server.ts)).
6. `Info.plist` still references AppReveal in local-network discovery text and publishes `_appreveal._tcp` instead of `_nessie._tcp` ([macos/Nessie/Info.plist](../macos/Nessie/Info.plist)).

## External Checks Used For Validation

### OpenAI Realtime docs

The official OpenAI Realtime docs currently document `gpt-realtime` as the speech-to-speech model family, and show `session.created` followed by `session.update`. That supports keeping the invalid-model finding and rejecting `gpt-realtime-1.5`.

### MCP 2025-11-25 transport spec

The current transport spec supports JSON responses on POST requests, requires `GET` to return SSE or `405`, treats `MCP-Session-Id` as optional to assign, and requires `400` for invalid `MCP-Protocol-Version`. This supports keeping the compliance findings but rewriting them more carefully.

### `pnpm audit --prod`

The audit returned zero advisories for the current production dependency graph. That does not prove the dependency set is ideal, but it does mean the original bonjour/CVE claim is not substantiated by the local lockfile.

### Gemini CLI and Claude CLI

The targeted external-model checks aligned with the manual review on the contentious points that mattered:

- both agreed `Promise.all` preserves input order, so M-16 should be removed
- both agreed the session ID is optional to assign, so C-13 should be removed
- Gemini also aligned with keeping the core security and voice-path findings

## Priority Order

1. Lock down `/mcp` with authentication and origin checks.
2. Remove or sandbox dangerous tools before exposing any MCP surface.
3. Rotate secrets from `.env`.
4. Fix the voice architecture: valid realtime model, one transport, actual PCM path, explicit lifecycle ownership.
5. Clean up MCP transport behavior and stale protocol metadata.
6. Remove stale `helper` naming and documentation drift so the docs stop overstating implemented features.

## Bottom Line

The original report was directionally useful, but too many items were written at maximum severity without enough proof. The cleaned version should keep the real security and functionality failures, delete the bad spec interpretations, and stop presenting roadmap gaps as if they were production regressions.
