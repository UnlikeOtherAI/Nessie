# Inference routing, embeddings and the vector width

Chapter of [deployment.md](../deployment.md). Which Ledger adapter serves chat and embeddings, why the vector width is a schema change, and what a deployment with no UOA signer can do.

## Chat model and the Ledger service id

Ledger's proxy is `/v1/:serviceId/*`, and the segment is the service **Ledger**
registers — not necessarily one of the three providers Nessie compiles an
adapter for (`openai`, `kimi`, `deepseek`). `NESSIE_MODEL_SERVICE_ID` names that
segment, so the deployment default can sit on any Ledger service; a service with
no compiled adapter is reached through the generic OpenAI-compatible connector.
Unset, the segment defaults to `NESSIE_MODEL_PROVIDER`, which is the old
behaviour.

Production runs chat on Meta's muse-spark 1.3:

```
NESSIE_MODEL_SERVICE_ID=openrouter
NESSIE_MODEL_NAME=meta/muse-spark-1.3-contributor
```

Two things are easy to get wrong here:

- **1.3 is not on Ledger's `meta` service.** That service stops at
  `muse-spark-1.2`; 1.3 and 1.3-contributor are carried by Ledger's OpenRouter
  service, where model ids are vendor-qualified — hence `openrouter` as the
  service id and `meta/` as part of the model name.
- **`-contributor` is a data decision, not just a price.** It is roughly 12x
  cheaper on input and 21x on output ($0.10/$0.002/$0.20 against
  $1.25/$0.15/$4.25), and upstream treats its traffic as training-eligible.
  Nessie is multi-tenant, so that applies to tenant content. Drop the suffix to
  move to the standard tier.

The base URL and credential are unchanged: the configured Ledger base URL has
its path rewritten to the service id, and the same Ledger app key authenticates
it. An agent's own model selection still outranks the deployment default.

## Embedding model and vector width

Embeddings are routed separately from chat, because they are a separate
capability the chat provider may not offer at all. Production runs chat on
Ledger's DeepSeek adapter, which has no embeddings endpoint; embeddings go to
Ledger's Jina adapter instead:

```
NESSIE_MODEL_PROVIDER=deepseek
NESSIE_MODEL_BASE_URL=https://ledger.unlikeotherai.com/v1/deepseek
NESSIE_MODEL_API_KEY=lk_...

NESSIE_EMBEDDING_PROVIDER=openai-compatible
NESSIE_EMBEDDING_SERVICE_ID=jina
NESSIE_EMBEDDING_MODEL=jina-embeddings-v3
```

The embedding block inherits the chat host and key, so the request lands on
`https://ledger.unlikeotherai.com/v1/jina/embeddings` on the same Ledger bearer.
The three `NESSIE_EMBEDDING_*` values are **not** secrets and are therefore set
in `infrastructure/compose/docker-compose.prod.yml` on both the `api` and
`worker` services, not in the host `.env` — a host-only copy is invisible to
review and is lost when the host is rebuilt. They were missing in production
until 2026-08-11, and the symptom was quiet rather than loud: every run logged
`Memory search failed` / `kb_search: query embedding failed, degrading to
lexical-only` and carried on, so memory recall and knowledge-base search
silently ran without vectors.
Leave the block unset and embeddings follow chat exactly as they did before it
existed. `NESSIE_EMBEDDING_BASE_URL` / `NESSIE_EMBEDDING_API_KEY` point
embeddings at a different host entirely (a self-hosted inference box, say); a
signed `X-Nessie-Context` / `X-UOA-Delegation` pair is **not** sent to a host
that differs from the chat host, so a third-party embedding endpoint never
receives a delegation assertion.

**The vector width is coupled to the schema.** `thoughts.embedding`,
`thought_recalls.query_embedding`, and `knowledge_page_chunks.embedding` are
`vector(N)` columns, and `N` is stated once in
`packages/schemas/src/embedding.ts` as `EMBEDDING_DIMENSIONS` (currently 1024,
the native width of `jina-embeddings-v3`). Every embed request sends
`dimensions: EMBEDDING_DIMENSIONS`, so a provider that would answer at another
width fails loudly instead of writing vectors the database rejects.

Changing the embedding model to one of a different width therefore requires all
three of:

1. editing `EMBEDDING_DIMENSIONS`,
2. a Prisma migration re-typing those three columns (drop the
   `knowledge_page_chunks_embedding_idx` HNSW index, null the existing vectors,
   `ALTER COLUMN ... TYPE vector(N)`, recreate the index — see
   `20260811120000_embeddings_1024_dimensions`), and
3. re-embedding, because **vectors of different widths are not convertible**.
   The migration nulls them rather than truncating: a truncated vector is
   neither model's output and would silently poison every later cosine
   comparison. Nulled rows re-embed naturally — memory capture writes a fresh
   vector on the next write, `knowledge.embed` refills any chunk whose
   `embedding IS NULL`, and recall degrades to its lexical channel until then.

The `match_thoughts_scoped` / `match_thoughts_hybrid` / `match_thoughts_in_scopes`
functions need no change: PostgreSQL discards the typmod on function parameters,
so their `query_embedding vector(...)` declaration accepts any width.


## Ledger inference without UOA

The onboarding above is required for SSO and for signed Ledger identity. It is
**not** required to run inference through Ledger. A deployment can point
`NESSIE_MODEL_BASE_URL` at a Ledger route and set `NESSIE_MODEL_API_KEY` to a
Ledger API key with nothing else — no `UOA_*` variables, no OAuth client, no
RS256 keypair — and the API, the embedded worker, model dispatch, and the agent
model catalogue all work on that bearer alone:

```
NESSIE_MODEL_PROVIDER=deepseek
NESSIE_MODEL_BASE_URL=https://ledger.unlikeotherai.com/v1/deepseek
NESSIE_MODEL_API_KEY=lk_...
```

Ledger — not Nessie — decides what a given key must present. A key whose
`identityMode` is `optional` authenticates on the bearer; a key that requires
`X-Nessie-Context`, or that is product-bound, is rejected by Ledger with a 401
the operator sees immediately. Nessie pre-empting that decision is what used to
make an ordinary personal key unusable, so it no longer does.

Configure the `UOA_*` signer and the guarantees come back in full and
unweakened: every Ledger inference call carries `X-Nessie-Context` plus
`X-UOA-Delegation`, and a request whose originating user has no linked UOA
identity still fails closed before dispatch. The two modes are chosen once from
process env at startup — `loadLedgerIdentitySettings` returning null is the only
bearer-only condition — so no organization, user, or request shape can move a
signing deployment onto the unsigned path.

The signer is all-or-nothing across five variables, so a single typo silently
selects the unsigned mode. Both the API and the worker therefore log which mode
they resolved at startup whenever the model URL is a Ledger route — check that
line before concluding a deployment is signing.

**Multi-tenant caveat.** Without a signer, Ledger sees one deployment-wide key
and no per-call provenance, so Ledger-side usage cannot be attributed to a
specific organization. Nessie's own accounting is unaffected — `token_ledger_events`
and the `Budget` gate are scoped per tenant and enforced identically in both
modes — but Nessie budgets are soft caps recorded after spend, and they only
bind where an operator configured them. On a single-tenant or personal
deployment this is moot; on a multi-tenant one, either configure the `UOA_*`
signer so upstream usage stays attributable, or set per-organization budgets
deliberately.

This covers model/embedding inference and the agent model catalogue only.
DeepWater (`LEDGER_DEEPWATER_MCP_URL`, `LEDGER_PROXY_TOKEN`), builtin
`web_search`, and UOA billing keep their own product-bound credentials and
identity requirements unchanged, and still fail closed without them.
