# Builtin `web_search` — a Ledger-only Serper route

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md) so
it is read when the work touches the search builtin rather than loaded into
every session. `AGENTS.md` → "Architecture" carries the one-line summary and
points here; **this file is the rule.**

Builtin `web_search` is a Ledger-only Serper route. Ordinary agent, delegated
sub-agent, and workflow calls all post to
`${LEDGER_PUBLIC_URL}/v1/serper/search` with Nessie's product-bound
`LEDGER_PROXY_TOKEN`, a fresh signed `X-Nessie-Context`, optional linked-user
`X-UOA-Delegation`, and a stable tool-call id. The context must contain exact
user/org/team/agent/run provenance; workflow queue identity is checked
against its durable actor and installation scope before signing. Direct
`google.serper.dev` calls and `SERPER_API_KEY` fallbacks are forbidden.
Nessie's local connector rows are operational telemetry only; Ledger is the
raw usage/cost source and UOA is the sole commercial authority.
