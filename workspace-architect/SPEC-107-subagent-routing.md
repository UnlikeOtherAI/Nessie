# SPEC-107: Subagent Completion Routing Fix

## Issue
UnlikeOtherAI/Nessie#107 — tracks upstream bug `openclaw/openclaw#70574`

## Problem
When Agent A (parent) spawns Agent B (child) via `sessions_spawn`, Agent B's completion announce routes to Agent B's channel binding instead of Agent A's session. The parent never receives the subagent's completion notification.

## Root Cause
In `openclaw-codebase/src/agents/spawn-requester-origin.ts`, the `resolveRequesterOriginForChild` function calls `resolveFirstBoundAccountId` with `targetAgentId` (child) when `targetAgentId !== requesterAgentId` (cross-agent spawn). This resolves the **child's binding** instead of preserving the **parent's accountId**.

## Upstream Fix Location
**`openclaw-codebase/src/agents/spawn-requester-origin.ts`** (line ~113)

**Before (buggy):**
```typescript
params.requesterChannel && params.targetAgentId !== params.requesterAgentId
```

**After (fixed):**
```typescript
params.requesterChannel && params.targetAgentId === params.requesterAgentId
```

## Fix Explanation
- **Self-spawn** (`targetAgentId === requesterAgentId`): Call `resolveFirstBoundAccountId` — the agent is spawning itself and its binding applies.
- **Cross-agent spawn** (`targetAgentId !== requesterAgentId`): Do NOT re-resolve — preserve the parent's `requesterAccountId` unchanged.

## Implementation
The fix was implemented in the local clone of `openclaw-codebase` at:
`/home/dev1/.openclaw/workspace/openclaw-codebase/`
Branch: `feat/107-subagent-routing`

**Cannot push to `openclaw/openclaw`** — no write access. The fix needs to be applied upstream by a maintainer.

## Nessie-Side Impact
Nessie's OpenClaw interop layer (`src/openclaw/announce-converter.ts`, `src/openclaw/event-translator.ts`) correctly sets `parentSessionKey` in `session.announce` events. The routing bug is purely in the OpenClaw gateway's `resolveRequesterOriginForChild` — Nessie has no equivalent code path.

## Status
- [x] Issue #107 created on UnlikeOtherAI/Nessie
- [x] SPEC written
- [x] Upstream fix implemented in openclaw-codebase (local, cannot push)
- [ ] PR created (upstream — blocked on write access)
