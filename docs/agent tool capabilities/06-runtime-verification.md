# Runtime Alignment and Verification

## 14) Capability/approval alignment with runtime implementation

In the current app, role policies affect only high-level intent in some task paths and are not yet applied as a hard runtime gate for every tool invocation:

- `ROLE_POLICIES` and role tool arrays are string lists, not grant objects.
- no persistent policy merge layer for inherit/override/deny.
- no policy-aware tool transport layer for interactive sessions.
- no centralized prompt inheritance engine.

## 15) Runtime verification against current codebase

Current code only proves a subset of the model as currently configured.

1. `Bash` tool (CLI)
   - Status: **implemented**
   - File path: [BashTool.ts](../../src/tools/BashTool.ts)  
   - Evidence:
     - Registered in [src/tools/index.ts](../../src/tools/index.ts).
     - Discoverable via `findToolByName` in tool invocation paths: [orchestrator](../../src/agent/Orchestrator.ts), [MCP adapter](../../src/mcp/adapter.ts).
     - Input is validated by Zod before execute.

2. `FileRead` tool
   - Status: **implemented**
   - File path: [FileReadTool.ts](../../src/tools/FileReadTool.ts)
   - Evidence: same registry + invocation path, schema in tool file, execution in `call`.

3. `FileWrite` tool
   - Status: **implemented**
   - File path: [FileWriteTool.ts](../../src/tools/FileWriteTool.ts)
   - Evidence: same registry + invocation path, schema in tool file, execution in `call`.

4. `Glob` tool
   - Status: **implemented**
   - File path: [GlobTool.ts](../../src/tools/GlobTool.ts)
   - Evidence: same registry + invocation path, schema in tool file, execution in `call`.

5. `Grep` tool
   - Status: **implemented**
   - File path: [GrepTool.ts](../../src/tools/GrepTool.ts)
   - Evidence: same registry + invocation path, schema in tool file, execution in `call`.

6. `WebSearch` tool
   - Status: **implemented-partial**
   - File path: [WebSearchTool.ts](../../src/tools/WebSearchTool.ts)
   - Evidence: tool is registered/invokable and validates `query`, but it returns a synthetic DuckDuckGo URL rather than a real search backend.

7. `register new custom tools` (any tool type)
   - Status: **blocked**
   - Evidence: tool set is static array `allTools` in [src/tools/index.ts](../../src/tools/index.ts) with no runtime registration API.

8. `per-tool config as arbitrary JSON payload`
   - Status: **blocked**
   - Evidence:
     - Proposed shape in this doc uses `Record<string, unknown>` in `ToolCapabilitySchema`/`ToolRuntimeConfig` (spec proposal).
     - Tool input parsing is strict by tool-specific Zod schemas in [Tool.ts](../../src/tools/Tool.ts) and each tool file.
     - Runtime invocation path only passes parsed tool input and shared `ToolUseContext`, not a separate grant/runtime JSON config.

9. `checkbox per-agent allow/deny inheritance model`
   - Status: **blocked**
   - Evidence:
     - `ManagedAgent` currently stores `tools: string[]` in [src/agent/types.ts](../../src/agent/types.ts).
     - Role tool permissions are still string lists in [role-registry.ts](../../src/orchestration/role-registry.ts), without inherited/override grant merge logic.

10. `validation of tool execution permissions from role/agent policy`
   - Status: **blocked**
   - Evidence:
     - Orchestrator/spawn path checks role policy in task lifecycle contexts, but final `callTool` and `spawnSubAgent` execute selected tools without grant resolution/denial checks.
     - MCP adapter `callTool` currently resolves by name then executes [src/mcp/adapter.ts](../../src/mcp/adapter.ts), [src/agent/Orchestrator.ts](../../src/agent/Orchestrator.ts).

11. `interactive PTY sessions` (`session:start/send/read/interrupt/close`)
   - Status: **blocked**
   - Evidence:
     - No session registry or PTY-capable transport in current tool catalog.
     - `BashTool` is one-shot command execution and does not preserve stdin stream.
     - MCP server has no session-prefixed tool family.

12. `agent / tool-level prompt inheritance and overrides`
   - Status: **blocked**
   - Evidence:
     - No prompt layer model in tool/agent types.
     - Role and agent prompts are hardcoded in behavior paths; no inherited prompt resolver.

13. `tool/agent discoverability search endpoints`
   - Status: **blocked**
   - Evidence:
     - `GET /mcp` exposes `tools/list` with static metadata only.
     - No `/tools/search`, `/tools/tags`, `/agents/search`, or filtered registry index endpoint.

14. `sandbox controls (allowed paths, read-only outside, env denylist)`
   - Status: **blocked**
   - Evidence:
     - No central `SandboxPolicy` in execution path.
     - Tool calls pass through global context with no per-tool path/env enforcement.
     - File commands in `BashTool` execute directly via shell with command-defined paths.

15. `single-file tool import (json/yaml/md manifest)`
   - Status: **blocked**
   - Evidence:
     - No import endpoint (`/tools/import`) or folder watcher exists.
     - No manifest parser/validator for bundle files.
     - No marketplace manifest verification flow (signature/checksum + allowlist review).

16. `tool metadata fields for searchable discovery`
   - Status: **blocked**
   - Evidence:
     - Runtime tool schema currently does not include canonical `overview` or `instructions`.
     - No persisted `basePrompt`/prompt override data per tool.
     - No canonical tag index or one-pass full-text search index currently used by agents.

17. `Slack-style routing with hidden organizer and single responder arbitration`
   - Status: **blocked**
   - Evidence:
     - Orchestrator resolves explicit on-demand agents only via hardcoded name matching in [Orchestrator.ts](../../src/agent/Orchestrator.ts).
     - There is no channel model, no routing event trace, and no organizer arbitration state.

18. `organized point-of-view mode with optional reveal`
   - Status: **blocked**
   - Evidence:
     - No `agent.pointOfView` type or route-level confidence output in current tool/event model.
     - No UI toggle path for hidden versus visible POVs in existing event/state channels.

19. `dedicated SSH tool with run/session modes`
   - Status: **blocked**
   - Evidence:
     - No single `ssh` tool entry exists in [src/tools/index.ts](../../src/tools/index.ts) or `MCP` tool registry.
     - No host/key allowlist enforcement for SSH in current tool policies.
     - No session-level remote transport path for persistent command exchange.

20. `organization-aware permission evaluation before routing and tool calls`
   - Status: **blocked**
   - Evidence:
     - No deny-first policy chain from org -> team -> channel -> role -> agent -> tool.
     - No `/access/check` endpoint and no per-call policy reason trace in event stream.

21. `organization-level membership and visibility model`
   - Status: **blocked**
   - Evidence:
     - No persistent organization/team/channel membership model exists in persistence layer or routing context.
     - No policy check for protected/private channel discoverability.
     - Current `/chat` routes do not enforce user/team scope before routing.

22. `tool manifest imports for CLI tools`
   - Status: **blocked**
   - Evidence:
     - No `/tools/import` workflow for one-file manifests.
     - No manifest signature/allowlist/verification path.
     - No marketplace index ingestion path for signed catalog entries.

23. `local CLI/IDE wrapper command model`
   - Status: **blocked**
   - Evidence:
     - No canonical entries for `codex`, `claude`, `gemma`, `ollama`, or equivalent local automation tools.
     - No `toolConfig` model that persists arbitrary JSON command metadata for wrappers.
     - No wrapper-specific `helpCommand` discovery/metadata capture path.

24. `CLI/interactive command tool discovery`
   - Status: **blocked**
   - Evidence:
     - No tool registry index supporting `transport=pty|direct|http` with `basePrompt`, `instructions`, and arbitrary tags for CLI wrappers.
     - No deterministic discovery endpoint for tool capabilities and tag filters.

25. `stage-based execution loops with stable orchestrator aggregation`
   - Status: **blocked**
   - Evidence:
     - `ManagedAgent` runtime type does not persist the spec-level `executionPolicy` or orchestrator binding fields yet.
     - Current orchestration paths do not create multi-stage generate/refine/reevaluate pipelines with candidate fan-out and selection checkpoints.
     - No stable hidden organizer or fixed agent is assigned to gather all findings from parallel passes and choose the candidate that advances.
     - Task ledger and event model do not yet expose candidate-level provenance, rejected-result retention, or stage aggregation audit entries.
