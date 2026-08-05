# Context-Window Optimization Audit

**Date:** 2026-07-07
**Scope:** The worker's agentic run pipeline — everything that consumes LLM
context-window tokens on a `run.execute` job.
**Status:** Audit + prioritized roadmap. Findings are current as of the commit
that adds this document; line numbers are approximate and will drift.

> Companion to the MCP connector work in
> [`external-tool-integration.md`](./external-tool-integration.md) §5. That
> slice made MCP **tool schemas** context-safe (deferred `mcp_find_tools` /
> `mcp_load_tools` / `mcp_drop_tools` above a threshold). This document audits
> the rest of the pipeline for the same class of problem.

---

## 1. Why this matters

Every agentic iteration re-sends the **entire** working context (system prompt
+ tool schemas + conversation + accumulated tool results) to the model. The
run budget (`maxTokens`) counts **provider-reported `usage.totalTokens` summed
across all invocations** (`worker/src/run/agentic-loop.ts` `sumTokens`), i.e.
cumulative input+output. With a 12-iteration ceiling, a context of _N_ tokens
costs on the order of _12 × N_ token-budget over the run.

That gives context reduction a **multiplier effect**: trimming 2k tokens of
always-on overhead saves ~24k token-budget across a full run, which directly
extends how much real work a run can do before hitting `maxTokens: 50_000`.

Two mitigations soften the picture and must be kept in mind when prioritizing:

- **Prompt caching.** The provider path is OpenAI / OpenAI-compatible (with
  `prompt_cache_key`, automatic prefix caching) and Kimi (explicit
  `cache_control: { type: 'ephemeral' }` breakpoint on the system+tools
  prefix). When the stable prefix (system prompt + tool schemas) doesn't change
  within a run, iterations 2…N read it from cache cheaply. There is **no native
  Anthropic connector** — Fable/Opus/Sonnet-class models run through the
  OpenAI-compatible path. MiniMax has no caching.
- **Existing caps.** Memory injection, conversation length, and MCP schemas are
  already bounded (see §5). The gaps are specific and enumerated below.

---

## 2. The pipeline (where tokens come from)

Single assembly path, `worker/src/run/execute/run-job.ts` →
`buildModelPrompt` + `resolveAgentTools` + `buildMcpToolset` →
`runExecutionAgentLoop` → `runAgenticLoop`.

The prompt that enters context each turn is, in order:

1. **System message** (`worker/src/run/execute/prompt.ts` `buildModelPrompt`):
   `You are <name>.` + the agent's full `systemPrompt` + a fixed static
   instruction block (date/time, tool-usage rules, channel-disambiguation
   rules, a "write like a person" style block).
2. **Memory message** — a second `system` message with injected long-term
   memories (only when there are hits).
3. **Conversation** — up to the 20 most-recent non-system thread messages.
4. **Current prompt** — appended if not already the last user message.
5. **Tool schemas** — passed alongside the messages on every inference call:
   the allowed builtin set + the MCP toolset view.
6. **Accumulated tool results** — appended as `role: 'tool'` messages as the
   loop runs, and re-sent every subsequent iteration.

---

## 3. Findings

Each finding notes location, whether it is always-on, whether it scales with
data, and the current cap (if any).

### Tier 1 — clear wins, low risk

#### F1. MCP and `delegate` tool *results* enter context uncapped

**Location:** `worker/src/run/mcp-toolset.ts` (`dispatch` returns
`result.output` with no truncation); `worker/src/run/execute/agent-loop.ts`
(the `delegate` branch returns the sub-agent's final text unbounded).
**Every other tool result is capped before it enters context:**

| Tool(s) | Effective cap before context |
|---|---|
| `web_search`, `web_fetch`, `document_read` | ~1,200 chars (`MAX_PREVIEW_LENGTH`) |
| `workspace_search` | ~4,000 chars |
| `kb_page_read` | 20,000 chars (`PAGE_BODY_CHAR_CAP`) |
| `file_read`, `file_glob`, `http_fetch`, other builtins | 32,000 chars (`truncateToolResult`) |
| **MCP tools** | **none** |
| **`delegate` sub-agent result** | **none** |

The builtin/direct path routes through `wrapTool` / `wrapBuiltinResult` in
`worker/src/run/tools.ts`, both of which call `truncateToolResult` (32k). MCP
dispatch and `delegate` skip that gate entirely. A connector that returns a
large JSON payload (or a chatty sub-agent) injects it whole, and — per F2 — it
persists across every remaining iteration.

- Always-on: no (only when the tool is called).
- Scales with data: **yes, unbounded.**
- Cap: **none.**

**Impact:** High. **Risk:** Low. **Effort:** Tiny (route both through a cap;
an MCP-specific limit smaller than 32k is reasonable since connector output is
often verbose JSON).

**✅ Resolved.** `runAgenticLoop` now truncates **every** tool result at the
single point where it enters context — `messages.push({ role: 'tool', … })` in
`worker/src/run/agentic-loop.ts` — via `truncateToolResult` (32k cap). This
catches MCP dispatch and `delegate` output, which previously had no cap. The
builtin per-tool caps in `tools.ts` still run first; the truncation marker is
`\n\n[truncated N chars]` and is idempotent (a pre-truncated string is detected
and not re-marked), so the double pass is safe. A tighter MCP-specific limit is
still a possible refinement.

#### F2. Tool results persist verbatim for the rest of the run; nothing summarizes

> **Resolved (2026-08-05).** Real compaction now exists:
> `worker/src/run/context-compaction.ts` folds the elder transcript into a
> rolling work-state note (verbatim-URL sources section, closed tool groups
> only, cooldown + bounded attempts, invocations counted in run totals);
> `trimConversationToFit` is demoted to emergency fallback and the dead
> `buildCompactionPrompt` was removed. See
> `docs/plans/2026-08-05-run-budgets-context-and-research-routing.md` §8.
> Original finding kept below for context.

**Location:** `worker/src/run/agentic-loop.ts` (the `messages` array is grown
and re-sent each iteration; tool results appended as `role: 'tool'` are never
removed or condensed after use). `buildCompactionPrompt`
(`worker/src/run/context-management.ts`) — a real "summarize this history"
prompt — is **dead code with zero callers** (only referenced from a planning
doc). The loop's only reduction is `trimConversationToFit`, which **hard-drops
the oldest assistant+tool groups whole** when context crosses 85% of the
budget, with no summary left behind. There is also **no dedup**: calling the
same tool with the same args twice (both below the loop-detection threshold of
3) keeps **both** full outputs.

- Always-on: results accumulate as the run proceeds.
- Scales with data: yes.
- Cap: only whole-group front-eviction at the budget ceiling (see F3).

**Impact:** High (this is the biggest long-run quality lever). **Risk:** Medium
(summarization changes what the model sees mid-run; needs test coverage).
**Effort:** Large. Recommended as its own focused slice — see §4, item 3.

#### F3. Context budget is a hard-coded 100k, not model-aware

> **Resolved (2026-08-05).** `worker/src/run/context-window.ts` supplies a
> per-model window (small conservative map, 100k default for unknown models,
> 0.85 estimator safety factor); compaction triggers at ~80% of the effective
> window. Revisit the map as real model metadata becomes available. Original
> finding kept below for context.

**Location:** `worker/src/run/agentic-loop.ts` —
`CONTEXT_BUDGET_TOKENS = 100_000`, `CONTEXT_TRIM_THRESHOLD = 0.85`,
`CONTEXT_TRIM_TARGET = 0.75`. Trim fires at ~85k and cuts down to ~75k,
regardless of the model. Fable/Opus/Sonnet-class windows are 200k+, so we throw
away roughly half the usable context and evict the agent's early work earlier
than necessary. `packages/runtime/src/inference/model-capabilities.ts` already
knows real window sizes; nothing feeds them into the loop. The token estimator
`estimateTokens = ceil(len / 4)` drives **only** these trim decisions — never
billing (billing uses provider-reported `usage.totalTokens`), so a rough
heuristic is acceptable here.

- Always-on: yes (the ceiling governs every run).
- Scales with data: n/a (it's the ceiling).
- Cap: fixed literal, not derived from the model.

**Impact:** Medium-High. **Risk:** Low. **Effort:** Small. Note the trade-off:
a higher ceiling lets a run hold more, but each retained token is re-sent every
iteration and counts against `maxTokens`, so this pairs naturally with F1/F2.

### Tier 2 — worthwhile, more work

#### F4. No duplicate-result collapse

Covered under F2 (no dedup). A cheap, separable improvement: when an identical
`(toolName, args)` result already sits in context, replace the second result
body with a short "identical to the earlier call" reference. Loop detection
(threshold 3) and the circuit breaker already short-circuit *execution* on
repeats, but only after two full executions+appends, and neither removes
outputs already in context.

**Impact:** Medium. **Risk:** Low. **Effort:** Small.

### Tier 3 — polish / caching

#### F5. Builtin tool schemas are always inline (no deferral)

**Location:** `resolveAgentTools` (`worker/src/run/tool-policy.ts`) materializes
the full `description` + `parameters` schema for every allowed builtin. There
are **46 builtin definitions** (~15–22 KB serialized ≈ 4,000–6,000 tokens for
the full set; ~3,000–4,000 for the 32-tool shared-agent set after
`personalAssistantOnly` gating). The find/load/drop deferral built for MCP
tools does **not** apply to builtins. **However**, the stable system+tools
prefix is cache-eligible, so on a caching provider the marginal per-iteration
cost is largely absorbed after the first call. The uncached first call and the
MiniMax path still pay full price.

**Impact:** Low-Medium (caching mitigates). **Risk:** Low. **Effort:** Medium.
Lower priority than the raw token count suggests.

#### F6. Two inputs bounded by count/config, not tokens

- **Agent `systemPrompt`** (`prompt.ts`) is injected verbatim with **no cap** —
  a large configured prompt is re-sent every call.
- **Conversation history** is capped at **20 messages**, not tokens
  (`loadConversation`). Twenty long messages is unbounded in token terms.

**Impact:** Low-Medium (edge cases). **Risk:** Low. **Effort:** Small.

#### F7. Cache-friendliness of the stable prefix

- The system prompt embeds `new Date().toISOString()`. It is stable **within** a
  run (built once) but **rotates the cross-run cache key** for every agent, so
  two runs of the same agent never share the cached prefix. Moving the timestamp
  out of the cacheable prefix (or rounding it, e.g. to the hour) would lift
  cross-run hit rates.
- The MCP deferred view **mutates the tool list mid-run** (load/drop), which
  changes the tools portion of the cacheable prefix and rotates
  `buildPromptCacheKey` (it hashes sorted tool names). This is an inherent
  trade-off of deferral — fewer tokens, less cacheable — and is acceptable, but
  should be documented so it isn't mistaken for a regression.

**Impact:** Low. **Risk:** Low. **Effort:** Small.

---

## 4. Priority summary

| # | Optimization | Impact | Risk | Effort |
|---|---|---|---|---|
| F1 | Cap MCP + `delegate` tool results | High | Low | Tiny |
| F3 | Model-aware context budget | Med-High | Low | Small |
| F2 | Real compaction (summarize, don't drop) | High | Med | Large |
| F4 | Duplicate-result collapse | Med | Low | Small |
| F5 | Defer builtin schemas | Low-Med | Low | Med |
| F6 | Token-cap `systemPrompt` + conversation | Low-Med | Low | Small |
| F7 | Cache-stable system prefix | Low | Low | Small |

### Recommended sequencing

1. **F1 + F3 first.** Both are low-risk, high-confidence, and F1 closes a real
   flood path in the connector surface just shipped. F3 is a small change that
   immediately buys headroom. F4 can ride along — it's small and complements F1.
2. **F2 as its own slice.** The biggest long-run quality win, but it changes
   what the model sees mid-run and needs dedicated test coverage (summarize old
   groups rather than dropping them; keep a compact marker so the agent knows
   history was condensed). Design the summarization budget so the summary itself
   doesn't reintroduce the cost it removed.
3. **F5–F7 as polish.** F6 and F7 are quick guards; F5 only meaningfully pays
   off on the non-caching path or to cut first-call cost, so defer it unless
   builtin counts grow.

---

## 5. Appendix — current bounding model

What is **already** capped (do not regress these):

| Input | Cap | Location |
|---|---|---|
| Injected long-term memories | ≤ 5 items × ≤ 220 chars | `worker/src/run/execute/memory.ts` (`MAX_MEMORY_RESULTS`, `MAX_MEMORY_CONTEXT_LENGTH`) |
| Conversation history | 20 most-recent non-system messages | `worker/src/run/execute/prompt.ts` (`loadConversation`, `take: 20`) |
| MCP tool schemas | inline ≤ 12 tools, else deferred; ≤ 15 loaded at once | `worker/src/run/mcp-toolset.ts`, `mcp-toolset-deferred.ts` |
| Most builtin tool results | 32,000 chars | `worker/src/run/tool-util.ts` (`truncateToolResult`) |
| Web tool results | ~1,200 chars | `worker/src/run/content-tools.ts` |
| `kb_page_read` | 20,000 chars | `worker/src/run/pa-tools/knowledge.ts` |
| Post-run memory consolidation | heuristic extraction, ≤ ~5 short memories | `packages/memory/src/consolidate.ts` |

Key constants:

- Main loop: `DEFAULT_BUDGET` = 12 iterations / 20 tool calls / 90 s /
  `maxTokens: 50_000` / `maxCostCents: 50` (`worker/src/run/agentic-loop.ts`).
- Sub-agent: `SUB_AGENT_BUDGET` = 4 iterations / 6 tool calls / 60 s /
  `maxTokens: 20_000` / `maxCostCents: 25` (`worker/src/run/delegate.ts`).
- Context ceiling: `CONTEXT_BUDGET_TOKENS = 100_000`, trim at 0.85, target 0.75
  (`worker/src/run/agentic-loop.ts`).
- Loop detection threshold 3; circuit-breaker error threshold 3.

`maxTokens` and `maxCostCents` are enforced against **provider-reported** usage;
the `len/4` estimator governs only the local context-fit trim.
</content>
