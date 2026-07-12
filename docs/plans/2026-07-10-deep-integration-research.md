# Research — How to make DeepSignal & DeepWater feel *native* in Nessie

Status: Research synthesis (2026-07-10). Feeds `docs/plans/2026-07-10-deep-integration-surface-registry.md`.

> **Method & confidence.** Multi-source fan-out (Slack, Microsoft, VS Code, Atlassian, the
> MCP project, ambient-agent UX writing). The workflow's 3-vote agent verification was cut short
> by a quota outage, so verification was **re-done frugally by direct source fetch** (6 targeted
> primary-source reads, no agent fan-out). Result: the load-bearing claims **CONFIRMED** against
> primary sources — Slack agent-design (§2), VS Code 38 contribution points (§1), MCP Apps
> SEP-1865 mechanics (§5), and the ambient-agent Overview/resolution-flows/deliver-via-existing-
> tools patterns (§3). **Two corrections from verification** (applied below): the specific
> notification *numbers* ("3–5/day", "15–30 min") were **not in the cited source** — the
> qualitative "batch / be strategic / don't over-notify" is supported, the figures are not; and
> Slack's structured activity blocks are real ("plan blocks", "task updates") but the specific
> "Thinking Steps / Timeline / collapsed-by-default" naming was **not confirmed** on the
> agent-design page. One earlier claim (VS Code "fully declarative, never imperative") was
> refuted (see §7).

## The one-line answer

Our integration still feels bolted-on because "deep" isn't *more surfaces on the Integrations
page* — every mature platform proves deep = **the external product becomes indistinguishable
from native primitives in the places users already work**, and its proactive value shows up as
a **triaged inbox**, not a settings card or notification spam. Three concrete gaps: (1) the
DeepSignal assistant must look and behave like a first-class DM that *streams its thinking*, not
a link that opens a plain channel; (2) proactive insights need an **Overview/Inbox with a strict
attention budget**, not one-card-per-webhook; (3) DeepWater reports must become **native
Knowledge documents**, not a separate list. Strategically, lean on **MCP Apps / MCP-UI** so the
products ship their *own* interactive UI that Nessie renders natively — instead of us
hand-rebuilding every card.

## 1. Deep = many named surfaces, gated — not one page

Every mature host gives an installed app **multiple distinct, named places to appear**, chosen
per interaction type, activation-gated and permission-scoped:

- **Slack**: six surfaces — App Home, Messages, Modals, Canvases, Lists, **Split-view pane** —
  each for a *different* interaction; Slack explicitly warns against surface misuse (no complex
  forms in messages, no passive content in modals, never App Home for shared content). [Slack: Agent design; App surfaces]
- **VS Code**: ~**38** declarative `contributes` points (view containers, views, panels,
  commands, menus, keybindings, settings — and now `chatAgents` / `languageModelTools` for AI),
  **activation-gated** (`onCommand`/`onView`) and conditionally visible via `when`/`enablement`
  clauses. [VS Code: Contribution Points — 38 points confirmed against the primary source]
- **Microsoft Teams / M365**: a manifest with *named* capability slots — `staticTabs`,
  `configurableTabs`, `bots`, `composeExtensions`, `connectors`, `dashboardCards`, `activities`
  (feed), `copilotAgents` — gated by declared **scopes** (personal/team/groupChat/copilot).
  Bots advertise curated `commandLists` (≤12) the host renders as discoverable actions. [MS Learn: Teams manifest schema]
- **Atlassian Forge**: apps contribute **modules** in `manifest.yml`, including a **Global**
  module that grants a full-page, end-to-end experience, plus dedicated **AI (Rovo) modules**. [Atlassian: Forge modules]
- **M365 Copilot**: external agents live in a native in-product **Agent Store** and are
  launched from Copilot Chat + the sidebar — *the same surfaces as the native assistant* — and
  can be **pinned** for persistent placement; IT gates them via governance before they appear. [MS Learn: Agents/Agent Store]

**Implication for Nessie.** Our surface-registry instinct was right, but the vocabulary is too
thin (3 types) and the gating too coarse. Grow it toward: `chat_assistant`, `nav_page`,
`overview/home`, `split_panel` (contextual side pane), `documents_section`, `command`/slash
entries, `card`, and `activity_feed` — each **scope-gated** (user/team/org) and
**permission-gated** (the connector's granted scopes), and **activation-lazy** (nothing renders
or loads until the product is linked). This is the VS Code/Teams/Forge model.

## 2. The external assistant: make it a native DM that *thinks out loud*

Slack has **unified agent chat into the standard Messages/DM surface** and is **deprecating**
the separate assistant view (`assistant_view`): an agent conversation should "look and feel
identical to a regular direct message," reply **in-thread**, and surface **suggested prompts at
the top of the Messages tab**. [Slack: Agent design; assistant deprecation] Concrete rules we're
not yet following:

- **Identity**: lead with **function over personality**, a clearly **non-human avatar**, and a
  one-line description of what it does. Label actions taken **"on behalf of [user]"** and mark
  AI-generated/unreviewed content. [Slack: Agent design]
- **Onboarding**: 2–4 (Slack) / up to 6 (M365 `conversation_starters`) **contextual suggested
  prompts** on first contact — the discovery mechanism. We show none today. [Slack; MS Learn]
- **Status + streaming**: show a status indicator the instant the user sends, stream long
  replies, and **name tools in plain language** ("Looking up your calendar"). [Slack]
- **Thinking steps** (the big miss): Slack's agent-design guidance references structured
  activity rendering — **"plan blocks"** and **"task updates"** — for surfacing what the agent is
  doing (the finer "Thinking Steps / Timeline / collapsed-by-default" feature naming was *not*
  confirmed on the agent-design page and may be newer/blog material — treat the specific block
  taxonomy as indicative, not gospel). M365's run view shows steps + an **activity map** + **links
  to the records touched**. We already map DeepSignal `activities` → cards; we should render them
  as a **structured, collapsible plan/timeline** inline in the turn, not flat cards — the general
  pattern (surface reasoning, collapsed by default, expandable) is sound. [Slack: Agent design — CONFIRMED; MS Learn: agent run view]
- **Handoff**: M365 uses a declarative `worker_agents` list so a primary agent delegates to
  others. Nessie's PA should be able to **hand off to DeepSignal** (and back) rather than the two
  being unrelated DMs. [MS Learn: declarative agents]

## 3. Proactive insights = an Inbox/Overview with an attention *budget* (not spam)

This is where "decision intelligence you shouldn't miss" lives or dies. The ambient-agent UX
literature is blunt:

- **Be strategic, don't bombard** — over-notification causes alert fatigue and churn; measure
  **notifications acted on (weighted by importance)**, not notifications sent. *(Verified
  qualitatively; the specific "3–5/day ceiling" and "23-min recovery" figures circulating in
  practitioner writing were NOT in the cited source — use as loose heuristics, don't quote as
  fact.)* [ambient-agent UX — CONFIRMED qualitative; numbers UNVERIFIED]
- **Batch over real-time interrupts** — reserve interruptions for genuinely time-sensitive,
  actionable items; deliver the rest as a pulled digest. *(The "only interrupt if action needed
  in 15–30 min" rule is a reasonable heuristic but was not stated in the cited source.)* [ambient-agent UX — direction CONFIRMED; threshold UNVERIFIED]
- **Synthesize**: an LLM should merge related alerts into **one** natural-language summary
  answering *what happened / likely impact / next steps*; prioritize by **confidence × severity**
  calibrated on outcomes, not surface features. [ambient-agent UX]
- **Open to an Overview Panel**: agent state, recent missions, **items needing human oversight**,
  output metrics — because the user's first question is "what has it been doing?" Back it with an
  **Activity Log** (chronological, task-level). [ambient-agent UX]
- **Five resolution-flow types** for any item needing a human: **Communication** (inform),
  **Validation** (agent paused for approval), **Decision** (pick an option), **Context** (supply
  missing info), **Error** (explain + recover). [ambient-agent UX]
- Microsoft surfaces autonomous-agent activity as an **inbox-style UX** (every action in one
  streamlined view, filterable, shareable) — *not buried in settings*. [MS: agent activity feed]

**Implication.** Our current design posts one insight card per `insight.surfaced` webhook into
the channel — that's exactly the over-notification anti-pattern. Instead: the **Signals page
becomes an Overview/Inbox** (triage: act / snooze / mute, grouped by priority, opening to a
"mission" detail with the right resolution flow). The channel/notification path gets a **per-user
daily budget + batching + synthesis**; only genuinely time-sensitive, actionable items interrupt.
DeepSignal's webhook already carries `insightId` + `actions`; add a **severity/confidence** score
and a **batchable digest** rather than firehosing.

> **Status (2026-07-12): shipped.** The Signals page is now an Overview/Inbox — an attention
> tally ("N need attention · X opportunities · Y risks"), active signals grouped by kind (risks
> first, then recency, since the digest exposes no severity field to sort on), inline act / snooze
> / mute, a "Show resolved" toggle over the `include=all` param, and a mission detail drawer. The
> webhook receiver (`api/src/services/deepsignal-webhook.ts` + `deepsignal-digest.ts`) coalesces
> insights into a single rolling "You have N new signals" digest message per user (updated in
> place within the coalesce window; per-insight ids retained for idempotency + counts-by-kind) and
> budgets fresh proactive digests per user per rolling window; over budget the insight is still
> recorded on the digest but the channel interruption is suppressed. The window/budget figures are
> env-tunable heuristics (`NESSIE_SIGNAL_DIGEST_WINDOW_MS` ~1h, `NESSIE_SIGNAL_BUDGET_MAX` 6 /
> `NESSIE_SIGNAL_BUDGET_WINDOW_MS` 24h) — deliberately **not** hardcoded as law, per the
> verification caveat above. Deferred: a true LLM synthesis of related alerts and a
> severity/confidence score from the product.

## 4. Deep-research output: weave into existing tools, don't silo

"Content-heavy outputs (reports, summaries) should be delivered through the user's **existing
tools** rather than requiring a separate login/destination" — the distinction between
content-heavy and operations-heavy outputs. [ambient-agent UX] This validates **DeepWater →
Documents**, but deeper than a list: a finished research report should become a **first-class
Knowledge page/artifact** in Nessie (title, sources, body), deep-linked from the chat turn and
the run row — not a separate silo the user context-switches into. The Research section is the
*index*; the report itself lives in the document model. (Our run records already carry
`knowledgePageId` — lean on it.)

> **Implemented (2026-07-12).** A completed run's row in the Documents "Research" view
> (`DeepWaterResearchView` → `DeepWaterRunHistory`) now opens its native Knowledge document as
> the primary action — the run title links to it and an "Open document" button leads, with
> "Open original report"/"Open chat" as secondary. `knowledgePageId`-only deep links (no
> `spaceId`, since the run record doesn't carry one) are resolved via a page lookup in
> `KnowledgeBasePage`, and `openPageDeepLink` now clears any active product view first so the
> link always lands on the real document instead of staying behind the Research index. Runs
> without a `knowledgePageId` (still running, failed, or predating the Knowledge draft) degrade
> to status + chat/report links, unchanged. The chat-turn deep link is only partially done: the
> DeepWater launch card (`buildDeepWaterLaunchMetadata`) is emitted once at launch, before
> `knowledgePageId`/`reportUrl` exist, and run completion is only reported back as plain PA text
> (no uiCard is re-emitted on `deep_water_run_update`) — adding one is a real feature (new
> worker-side message/card emission on run completion) owned by the DeepWater run-update path,
> deferred here. As a stopgap, the PA's handoff instructions now ask it to mention the
> `/knowledge-base?pageId=...` link in its own completion reply when it set `knowledgePageId`.

## 5. Strategic lever: let the products ship their own UI via MCP Apps / MCP-UI

The most important finding for avoiding "Nessie hand-rebuilds every product's cards forever":

- **MCP Apps (SEP-1865)** is the **first official MCP extension**, standardizing how an MCP
  server delivers **interactive UI** to hosts: a tool references a pre-declared UI resource
  (`_meta.ui.resourceUri`, `ui://` scheme, MIME `text/html+mcp`), the host renders it in a
  **sandboxed iframe**, and UI↔host talk over the **existing MCP JSON-RPC via postMessage**.
  Built with OpenAI's Apps SDK + the community **MCP-UI** project; already rendered by Claude,
  Goose, VS Code Insiders, ChatGPT with no client-specific code. [MCP blog: MCP Apps (2025-11 / 2026-01)]
- **MCP-UI** delivers UI three ways — inline HTML (srcDoc), external URL, and **Remote DOM** —
  in sandboxed iframes; components **emit intents** (`tool`/`intent`/`prompt`) that the **agent
  mediates** rather than mutating host state directly; prefer **pre-built maintained components**
  over agent-generated UI for reliability. [MCP-UI docs/SDKs]

**Implication.** Today Nessie parses DeepSignal's `activities`/`cards` and re-renders them as
`IntegrationUiCard`s — a per-product mapping we own forever. The forward path: have DeepSignal &
DeepWater ship **MCP Apps UI resources** (a signal card, a research-report viewer, a pursuit
board) that Nessie renders in a **sandboxed, intent-mediated** host — so a new product surface is
*their* code, not ours. This is the real "deep integration" endgame and it's now a standard, not
a bespoke bridge. (Requires a sandboxed-iframe MCP-UI host in admin + the security model: pre-
declared/reviewable templates, auditable JSON-RPC, user consent for UI-initiated tool calls.)

## 6. Connection UX

Run **OAuth inside the product** (a Connect portal), never bounce the user elsewhere; the
defining property of an embedded integration is that **users don't build/maintain it outside the
host** and don't perform the cross-platform action manually. [embedded-integration writing] We do
this (dynamic OAuth in-app) — keep it, and make activation *visibly* light up the surfaces (§1).

## 7. Anti-patterns that make it feel shallow (what we must avoid)

- **Settings-only / one-page dumping** — the original complaint; contribution surfaces fix it. [Slack; Teams; Forge]
- **Surface misuse** — complex forms in chat, passive content in modals, private App Home for
  shared content. [Slack]
- **Over-notification** — the fastest path to churn; needs budget + batching + synthesis. [ambient-agent UX]
- **Text-only ceiling** — rich domains need real interactive components (→ MCP Apps). [MCP blog]
- **Forcing manual cross-platform actions** — the thing an embedded integration exists to remove. [embedded-integration writing]
- **Refuted / dropped**: the claim that VS Code's model is "*fully* declarative, never
  imperative" was refuted — `contributes` is declarative JSON, but extensions still draw
  imperative UI (webviews, tree data providers). Lesson: a contribution registry declares
  *where/when*; the product still supplies the *rendered content* (which is exactly what MCP Apps
  standardizes). [refuted 3/3 vs VS Code primary source]

## 8. Revised recommendation for Nessie (prioritized)

1. **Reframe the DeepSignal DM as a native, thinking assistant** — conversation starters,
   function-first identity + non-human avatar, status-on-send, and **collapsed plan/timeline
   thinking steps** rendered inline (not flat cards). *(Highest impact, no backend blocker.)*
2. **Turn Signals into an Overview/Inbox** — priority-grouped triage (act/snooze/mute), mission
   detail pages with the five resolution-flow types, an Activity Log. Make the **webhook path
   budgeted + batched + synthesized**, not one-card-per-event. *(This is the "things you
   shouldn't miss" product; get it right.)* **— Done (2026-07-12):** kind-grouped triage inbox +
   mission detail drawer, and a coalesced + budgeted webhook digest (see §3 status). Remaining:
   LLM synthesis of related alerts, an explicit Activity Log, and the full five-flow taxonomy
   (today's drawer covers Communication + Decision via act/snooze/mute).
3. **Promote DeepWater reports to native Knowledge documents** — report → Knowledge page
   (`knowledgePageId`), deep-linked; the Research section is the index, the doc lives in the
   document model. **Documents-view side implemented (2026-07-12)** — see §4; the chat-turn
   card deep link is deferred (owned by the DeepWater run-update path, plain-text link only).
4. **Grow the contribution vocabulary + gating** — add overview/home, split-panel, command, card,
   activity surface types; gate each on scope (user/team/org) **and** granted permission;
   activation-lazy. *(Extends Slice A, doesn't replace it.)*
5. **Adopt MCP Apps / MCP-UI as the rendering standard** — build one sandboxed, intent-mediated
   MCP-UI host in admin; have DeepSignal/DeepWater ship their own UI resources. *(Strategic;
   removes the per-product-card treadmill. Larger effort — do after 1–3.)*
6. **PA ↔ DeepSignal handoff** — declarative delegation so the native PA can route to DeepSignal
   and back, instead of two unrelated DMs.

## Sources (primary)

- Slack — Agent design; App surfaces; Thinking Steps; App manifest: `docs.slack.dev`
- Microsoft — Teams manifest schema; declarative agents / Agent Store; agent activity feed: `learn.microsoft.com`
- VS Code — Contribution Points (38): `code.visualstudio.com/api/references/contribution-points`
- Atlassian — Forge modules: `developer.atlassian.com/platform/forge`
- Model Context Protocol — MCP Apps (SEP-1865), MCP-UI: `blog.modelcontextprotocol.io`, `mcpui.dev`
- Ambient-agent UX patterns; embedded-integration definitions (secondary/practitioner sources).

*Confidence caveat repeated: verify pass incomplete; treat §3's numeric thresholds as
well-supported heuristics, not gospel, and re-run verification before quoting figures externally.*
