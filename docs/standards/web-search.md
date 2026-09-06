# Builtin `web_search` — Ledger-routed, provider-agnostic, and showable

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md) so
it is read when the work touches the search builtin rather than loaded into
every session. `AGENTS.md` → "Architecture" carries the one-line summary and
points here; **this file is the rule.**

## Ledger owns the provider; Nessie owns the shape

Builtin `web_search` is Ledger-only. Ordinary agent, delegated sub-agent, and
workflow calls, the Agent Designer's sidebar lookup, the voice tool and the
search card's pager all post to Ledger with Nessie's product-bound
`LEDGER_PROXY_TOKEN`, a fresh signed `X-Nessie-Context`, optional linked-user
`X-UOA-Delegation`, and a stable tool-call id. The context must contain exact
user/org/team/agent/run provenance; workflow queue identity is checked against
its durable actor and installation scope before signing. Direct
`google.serper.dev` calls and `SERPER_API_KEY` fallbacks are forbidden, and so
is any second HTTP client for a second engine. Nessie's local connector rows are
operational telemetry only; Ledger is the raw usage/cost source and UOA is the
sole commercial authority.

**Which engine runs is Ledger's decision, not Nessie's.** There are two
endpoints, chosen by configuration in `resolveSearchEndpoint`
(`packages/runtime/src/web-search.ts`):

- `NESSIE_LEDGER_SEARCH_PURPOSE_API_ID` **set** → `POST
  /v1/purpose/:id/search`. Ledger walks that Purpose API's route list in
  priority order, spills to the next provider on a 429 rather than failing, and
  always answers in its canonical `search.v1` envelope — a multi-provider walk
  has no predictable wire format, so canonical is the only honest shape.
- **unset** → `POST /v1/serper/search`, the single-service passthrough, which
  returns Serper's own body.

This mirrors `NESSIE_LEDGER_IMAGE_PURPOSE_API_ID` for image generation, and for
the same reason: **adding SerpAPI, Brave or Perplexity is a Ledger route
change, not a Nessie deploy.** Both wire formats normalise to one
`WebSearchOutput` in `web-search-response.ts`, and that is the only place a
provider shape is ever read. A per-provider branch anywhere else — a client, a
credential, a `if (provider === …)` in a tool or a card — is the defect this
seam exists to prevent. The one body both routes accept is `{q, num, page}`:
the Purpose API's request schema is `.strict()`, so nothing else may be sent.

The single body field a caller may not add is `format`. The canonical envelope
is requested by *addressing the purpose route*, never by a flag; the
passthrough route does not translate.

The query reaches the provider verbatim. It used to have `search`, `latest`,
`web` and friends stripped out of it by a regex — which mangled honest queries,
worked only in English, and was exactly the content keyword-matching
`AGENTS.md` forbids. Writing a good query is the model's job.

## Paging

`page` is 1-indexed and clamped to 10; `count` is 1–10 and defaults to 5. A page
that comes back full sets `hasMore`, which is the same inference a search
engine's own "next" arrow makes — no provider reports a total, and pretending
otherwise would put a page count on the card that nothing could honour.

## The search card

`present: true` posts the page into the conversation as a **search card**: the
results as a search engine renders them, with a pager. Default false — the model
gets the same grounded results either way, so a card appears only because the
agent decided seeing the sources is the point. A run that searches five times
while thinking posts nothing.

Four things make it a card rather than an eighth look-alike
([`agent-cards.md`](agent-cards.md)):

1. **It is not an `AgentCard`, deliberately.** An agent card is an interactive
   object: a row is its authority, its press is claimed once by a conditional
   UPDATE, and who may press is a per-viewer server decision. A page of results
   has none of that — nothing is pressed, nothing resolves, every viewer sees
   the same thing — so the payload rides in the message's own metadata
   (`webSearch`, `WebSearchCardSchema` in `@nessie/schemas`) the way the
   integration `uiCards` do. Putting it through the card vocabulary would have
   meant relaxing "a card has at least one action" for a card nobody acts on.
2. **The tool writes it, never the model.** The payload is built from the
   provider response by `toWebSearchCard`. A source list whose links the model
   retyped could misquote a URL, which is the one thing a source list must not
   do.
3. **The message reads as a message.** `renderWebSearchCardPlainText` is the
   `content`, so search, notifications, exports, other clients and the agent's
   own transcript see the results as text; the feed suppresses that text where
   it renders the card, exactly as it does for an agent card.
4. **Opening a thread costs nothing.** The posted page is in the metadata, so a
   thread full of search cards makes no requests and spends nothing.

A workflow step deliberately ignores `present`: it runs outside any
conversation, so there is no thread to post into. A workflow that should show
results sends them with `message_send`.

## `POST /api/web-search` — the human search door

The card's `Next`, `Previous` and related-search chips are searches the *reader*
asked for, so they run through `POST /api/web-search` rather than replaying the
agent's call. That route:

- is signed as the person who clicked (`systemComponent: 'web-search'`), so the
  spend is attributed to them and not to an agent that stopped running;
- passes the same budget gate an interactive model call passes — a click that
  costs money is still a cost — and answers `402 BUDGET_EXCEEDED` when blocked;
- answers `503 WEB_SEARCH_UNCONFIGURED` on a deployment with no Ledger, because
  a pager that silently 500s is worse than one that says why;
- returns exactly the same `WebSearchCard` the tool posts, so a page fetched by
  a click and a page fetched by an agent are the same object.

Each page is cached in the browser under its own key (`webSearchKeys.page`), so
paging back to a page already read is free rather than a second metered search.

## Files

| Concern | File |
| --- | --- |
| Endpoint choice, request, clamping | `packages/runtime/src/web-search.ts` |
| Canonical + Serper parsers, one output shape | `packages/runtime/src/web-search-response.ts` |
| Provider response → card payload, plain text | `packages/runtime/src/web-search-card.ts` |
| Card payload + request contract | `packages/schemas/src/web-search-card.ts` |
| Tool declaration (`query`, `page`, `count`, `present`) | `packages/runtime/src/builtin-web-tools.ts` |
| Agent tool + card posting | `worker/src/run/content-tools.ts`, `worker/src/run/web-search-card.ts` |
| Human search door | `api/src/routes/web-search.ts`, `api/src/services/web-search.ts` |
| The card | `admin/src/components/features/channels/WebSearchResultsCard.tsx` |
