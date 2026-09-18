# Model availability — the owner decides, and the decision is real

An organisation owner governs which of the deployment's models may be used, on
`/settings/organization/models` (**Organization → Models**). This file is the
rule; `AGENTS.md` → "Architecture" carries the one-line signpost.

## The list is Ledger's, not Nessie's

Nothing local enumerates "every model available in the deployment". Ledger does,
per request, through `listLedgerAgentModels`
(`packages/team-admin/src/ledger-agent-model-catalog.ts`). The page therefore
reads the live catalogue and **left-joins** the organisation's own
`inference_models` rows onto it.

Consequences that are not negotiable:

- **A pair with no local row is available.** Availability is stored as an
  exception list, never an allow-list, so a model Ledger adds tomorrow is usable
  tomorrow rather than invisible until somebody notices it.
- **A catalogue that cannot be read is said, never guessed.** The route answers
  `503` with Ledger's own error code and the page renders that instead of a
  list. A stale guess about what a deployment can run is worse than no list.
- **The page is paginated** through `PaginationParamsSchema` /
  `PaginationMetaSchema` with `total` required, like every other admin list. The
  cursor is the sorted `provider\0model` key, base64url-encoded and opaque.

## A row this page writes is a container, never a routing override

The same two tables carry an older meaning. `worker/src/run/inference-provider.ts`
applies an organisation-level provider override only when the provider row is
`enabled = true AND lifecycle_status = 'approved'`, and routing profiles
hard-fail on a non-runnable provider or model.

So the provider row this page upserts for a Ledger service id is created
`lifecycle_status = 'draft'`, `enabled = false`, with no `base_url` and no
credential binding — a pure container satisfying `InferenceModel.providerId`.
Nothing the Models page writes can change where a run is dispatched. One column
never carries two meanings: **this page decides selectability, the control plane
decides routing.**

## Disabling is enforced in two places, and both are required

1. **The picker.** `listAgentModelOptionsForUser`
   (`packages/team-admin/src/agent-model-options.ts`) filters its Ledger arm by
   `loadDisabledModelPairs`, so `GET /api/agents/models` stops offering a
   disabled pair. The availability set is awaited *outside* the two independent
   `allSettled` arms on purpose: a read that failed would have to fall open, and
   falling open means offering a pair the owner switched off.
2. **The write-time validator.** `assertAgentModelSelection`
   (`packages/team-admin/src/agent-model-selection.ts`) refuses a disabled pair
   with `AGENT_MODEL_DISABLED_FOR_ORGANIZATION` (HTTP 400). A picker-only filter
   would be bypassed by the personal assistant's `agent_create`/`agent_config`
   tools and by any client posting the pair directly.

**Personal model subscriptions are deliberately unfiltered.** An organisation
owner has no standing to enable, disable or spend a person's own consumer plan —
see [`personal-model-subscriptions.md`](personal-model-subscriptions.md). The
page copy states the omission so it reads as a decision.

## The enforcement decision for agents already pinned

**An agent already pinned to a pair that is later disabled keeps working, and
the fact is surfaced rather than left silent.** Chosen over failing the run:

- A disable that kills running agents makes the control unusable — nobody would
  flip a switch whose blast radius they cannot see beforehand.
- The run-time security boundary is elsewhere. Write-time validation is UX
  (the same split personal subscriptions already make); availability is an
  organisational preference, not an authorization.

It is not silent, in three places:

- **Before the decision:** each row on the Models page states how many agents
  are currently pinned to that exact pair (`agentCount`, from a `groupBy` over
  `agents`). Nothing renders a zero — a pair nobody uses says nothing, so the
  column reads as the list of rows that need care.
- **After it, where it is discovered:** the Agent Designer's model picker no
  longer offers the pair, so the existing "selection is unavailable" branch
  fires and `ModelUnavailableNotice` names both possible causes — retired
  upstream, or switched off here — with an owner-only link to the Models page.
  The two causes are indistinguishable from the client by construction: a
  filtered list cannot say why something is not in it.
- **On any attempt to move another agent onto it:** the validator's 400, whose
  message names Organization → Models.

`assertAgentModelSelection` takes `previousSelection` so an *unchanged* disabled
pair passes. Without it, disabling a model would block renaming, re-prompting or
re-scoping every agent already on it — a disable that bricks edits is not
"keeps working".

## The test button

`POST /api/inference/models/test` sends one short prompt to one exact pair and
reports the reply, the latency, or a structured failure carrying the provider's
own words.

- **Destination is per client, not per call.** `createInferenceService` rewrites
  the base URL to `/v1/<serviceId>` once, at construction, so testing pair
  (P, M) builds its own `createModelClient({ ...config.model, serviceId: P,
  modelName: M })` and `close()`s it afterwards.
- **Never hand-roll a fetch to a provider URL.** Going through
  `createModelClient` inherits IP-pinned egress; the root `eslint.config.js`
  egress block fails the build otherwise ([`egress.md`](egress.md)).
- **It is billed.** Attribution is mandatory on a signing deployment, so the
  call carries the owner's own provenance and appears in the token ledger. The
  prompt is one sentence and the output is capped at 64 tokens; the UI says the
  call is real and billed.
- **A failure is a result, not an exception.** The route answers 200 with
  `ok: false` and the provider's message, because only the provider's own words
  let an owner tell a bad key from a retired model from a timeout.

## Surface

| Screen | Element | Goes to |
|---|---|---|
| Sidebar → Organization | "Models", `ownerOnly: true` | `/settings/organization/models` — home |
| Agent Designer → model picker | `ModelUnavailableNotice`, owner-only link | `/settings/organization/models` |

Registered in `admin/src/router-lazy-pages.ts`, `admin/src/router.tsx`,
`admin/src/layouts/admin-shell/admin-nav-items.tsx` and
`admin/src/navigation/admin-surfaces.ts` — all four, each enforced by its own
admin test.

No migration: `inference_providers` and `inference_models` already carry
everything this needs.
