# Provider reasoning — asking for it, showing it, and giving it back

Authoritative standard for how Nessie requests a model's visible reasoning
("thinking"), streams it into the thought log, and replays it to providers
that demand it. [`AGENTS.md`](../../AGENTS.md) carries the one-line
invariant and points here; **this file is the rule**.

## The invariants

1. **Every OpenAI-shaped stream is read for both reasoning spellings.**
   `delta.reasoning_content` is DeepSeek's name, adopted by DashScope, vLLM
   and SGLang; OpenRouter normalises every upstream to `delta.reasoning`.
   `reasoningTextFromOpenAi` (`@nessie/runtime`) is the one reader, used by
   the connector and the Designer alike. Production's default route is
   OpenRouter, and a reader that knew only the first spelling showed no
   thinking at all there — the bubble sat on "Thinking…" until the answer
   landed.
2. **The thinking switch is a dialect decision made at the transport
   boundary.** `resolveReasoningDialect` maps the provider plus the Ledger
   service id — never a caller, a stored record or a model — onto one of
   three dialects, and `applyReasoningDialect` normalises every body the
   OpenAI-like connector sends, for `invoke`, `stream` **and** the raw
   `fetchCompletion` escape hatch the Designer uses:

   | dialect | when | asks for thinking with | output cap field | replays reasoning |
   |---|---|---|---|---|
   | `deepseek` | provider `deepseek`, or Ledger service `deepseek` | `thinking: { type }` | `max_tokens` (the only one DeepSeek documents) | yes, as `reasoning_content` |
   | `dashscope` | Ledger service `alibaba` (Alibaba Cloud Model Studio) | `enable_thinking` | unchanged | yes, as `reasoning_content` |
   | `openai` | everything else (OpenAI, OpenRouter, xAI, Z.ai…) | `reasoning_effort` alone | unchanged | no — `reasoning_content` is stripped from assistant messages, because OpenAI rejects a message carrying an unknown field |

   `reasoning_effort` is sent on every dialect exactly as `Agent.effort` maps
   it ([tech-and-run-budgets.md](tech-and-run-budgets.md)); DeepSeek
   documents that it maps `medium` to `high` itself. **No provider
   standardises these levels and none offers an endpoint that lists what a
   model accepts** — OpenAI takes `low/medium/high` (+`xhigh`, `minimal`,
   `none` on newer models only), DeepSeek `low/high/max`, DashScope
   `enable_thinking` plus `thinking_budget` on some families and
   `reasoning_effort` on others, OpenRouter a `reasoning.effort` it maps per
   upstream, Ollama a boolean `think` with `low/medium/high` on a handful of
   models, Anthropic a token budget. Nessie's vocabulary is therefore the
   standard: `Agent.effort` is `none | low | medium | high | xhigh`, each
   dialect clamps it to what its provider takes, and the only per-model
   discovery in the estate is Ollama's `thinking` capability flag from
   `/api/show`, which decides whether `think` is sent at all.
   **`none` is the off switch**: DeepSeek gets `thinking.type: disabled`,
   DashScope `enable_thinking: false`, Ollama `think: false`, Codex no
   `reasoning` object, and no dialect ever sends the literal `none` as an
   effort, because OpenAI's older reasoning models reject it.
3. **Thinking is requested only where a person can see it.** A streamed,
   non-JSON turn feeds the run's thought log, so it runs with thinking on. A
   silent utility call — compaction, checkpoint notes, delegates, JSON
   extraction — runs in the provider's non-thinking mode. This is not only
   economy: DashScope serves thinking **only on a stream** ("parameter
   `enable_thinking` must be set to false for non-streaming calls") and
   refuses JSON mode with thinking on ("Json mode response is not supported
   when enable_thinking is true"), so a hybrid model that defaults to thinking
   would otherwise reject every utility call.
4. **A turn's reasoning travels with its assistant message.** The connector
   returns `reasoningText`; the stage carries it out as `finalReasoning`; the
   agentic loop stores it as `reasoning` on the assistant `ProviderMessage`
   it pushes (tool-call turns and the empty-output recovery turn alike); the
   mapper puts it on the wire as `reasoning_content`; the dialect keeps or
   strips it. DeepSeek is explicit: once a request carries `tools`, "the
   `reasoning_content` must be fully passed back to the API in all subsequent
   requests — even for turns where the model did not perform a tool call",
   else HTTP 400. Reasoning is redacted with the same secret scanner as the
   reply (`redactMessageContent`), because it is derived from the same tool
   output. The zod mirror (`ProviderMessageSchema`) admits the field as
   optional so a crash checkpoint written before it existed still parses.
5. **The personal DeepSeek lane thinks too.** It used to pin
   `thinking: disabled` precisely because the transcript carried no
   `reasoning_content`; with replay in place the compiled `deepseek`
   connector owns one dialect for the direct and the Ledger-routed key alike,
   and the only thing the personal lane adds is the pinned egress
   (`safeFetch`) every direct DeepSeek key gets.
6. **Codex asks for summaries.** The Responses API streams
   `reasoning_summary_text.delta` only when the request carries
   `reasoning.summary`, so the Codex connector sends `summary: 'auto'`;
   without it a Codex agent's bubble never filled.

## The local lane

A local Ollama agent thinks under the same rule. The worker sets `thinking:
true` on the sealed attempt for a live, shown turn whose effort is not
`none`, and leaves it off for silent utility calls; the host sends Ollama
`think: true` only when the attempt asks **and** the model advertises the
`thinking` capability, because Ollama refuses the switch on a model without
it. Thinking streams back as `reasoning_text.delta` frames — the same
vocabulary as a cloud connector, so the thought log needs no local special
case — and the receipt carries the joined `reasoning`, which the loop replays
to Ollama as the assistant message's `thinking` field on a tool round. Both
fields are optional on the wire so an older host and an older server keep
reading each other. Ollama's per-model levels are not sent: too few models
accept them and nothing discovers which, so on this lane effort collapses to
on or off ([local-ollama-agents.md](local-ollama-agents.md)).

## What is deliberately not done

- **Kimi for Coding** (Anthropic Messages wire) is not asked for thinking;
  its backend sends `thinking_delta` on its own and the stream reader forwards
  it. Its tool calls are a text protocol (`<tool_use>{…}</tool_use>` rendered
  into the system prompt), and Kimi K2.7 frequently ends the turn right after
  the block's JSON, before the closing tag — production delivered a raw block
  to a person on 2026-09-22 because the parser demanded the tag. A block is
  now read by its balanced JSON with the tag optional, every `<tool_use>`
  fragment is stripped from the delivered text, and a native `tool_use`
  content block is honoured if the backend ever answers with one. Replaying
  Kimi's thinking blocks on tool rounds (the "Preserved Thinking" its docs
  say K2.7-code requires) needs a key to test against and is still open.
- **OpenRouter's `reasoning_details` blocks are not replayed.** Omitting them
  loses reasoning continuity across a tool round on some upstreams; it does
  not fail the request.
- **Reasoning is not persisted on messages.** DeepSeek's wording ("all
  previous turns") leaves open whether assistant turns rebuilt from thread
  history — which never carried reasoning — are also expected to replay it.
  If DeepSeek rejects such a request, the remedy is to persist reasoning with
  the message and replay it from history, not to disable thinking again.

## Where the reasoning is shown

The worker's `ThinkingRecorder` coalesces `reasoning_text.delta` into
`run_thinking_chunks` rows and `stream.reasoning` SSE events; the admin's
thinking bubble and the thought-process dialog read those
([agent-voice.md](agent-voice.md) for the bubble's place in the feed). The
Agent Designer streams its own `reasoning.delta` events from the same reader.
A provider that streams nothing under either spelling shows an empty bubble
by design — the bubble is the honest signal that a run is in flight.

## Ledger's part

Ledger's raw proxy (`/v1/:serviceId/chat/completions`) is byte-for-byte
pass-through in both directions: the request body, including the dialect's
switch and any replayed `reasoning_content`, reaches the provider unchanged,
and the provider's SSE frames — reasoning deltas included — reach Nessie
unchanged, with usage metered off the frames in flight. Nessie therefore
speaks each service's own dialect; Ledger does not translate, and adding a
service to Ledger that speaks a fourth dialect means adding it here.
