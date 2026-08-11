# Unsurfaced capabilities — the agreed decision

**Date:** 2026-08-11 · **Status:** Agreed, ready to build

Three independent passes over the same six production findings:

- **Fable** (design judgement, placement + entry points) — [2026-08-11-unsurfaced-capabilities.md](./2026-08-11-unsurfaced-capabilities.md)
- **kimix/Codex** (code verification, value-per-effort) — transcript in the session scratchpad
- **Claude** (production audit that found them; adjudication below)

They agreed on five of six. This file records the agreed plan, and — where the two
reviews disagreed — which way it was settled and why. Read it with
[AGENTS.md → Rule zero](../../AGENTS.md), which these findings produced.

## The correction both reviews made to the original audit

The audit reported 558 execution-runner rows and guessed "the worker inserts a row per
probe instead of upserting". **Both reviews independently disproved that.**
`registerExecutionRunners` (`worker/src/control/execution/runners.ts`) *does* upsert, on
`@@unique([provider, label])`. The leak is the label: `runnerLabelPrefix` is
`process.env.HOSTNAME` (`worker/src/index.ts:169`), which in Docker is the container id, so
**every redeploy mints two new immortal rows** (docker + gcloud) and nothing ever reaps the
old ones. 558 rows ≈ 279 deploys of archaeology. Same symptom, different bug, different fix.

## Agreed plan

| # | Capability | Decision | Home | In-context entry points |
|---|-----------|----------|------|-------------------------|
| 1 | Execution runners | **Fix the data first**, then a live-runners-only section | `/ops`, under Queue | `/ops` already computes worker liveness from these rows and shows an "Active runners" stat with nothing behind it — the section is what that number opens into |
| 1b | Env templates / instances / leases / usage-ledger | **Do not build** | — | All four empty; the sandbox feature is dormant. Instances belong in workflow-run detail when it wakes up |
| 2 | Audit summary + verify | **Fix the 500, then surface** | `/audit` header strip | `/settings/security` and `/policy` link in |
| 3 | Inference control plane | **Surface** | new owner-only `/settings/models` | Agent Designer's model picker shows a "provider is draft — deployment defaults apply" chip linking here. This is the load-bearing one |
| 4 | Run timing | **Surface** | `/ops/usage`, "Run latency" section | Owner-only echo on the Agents → Activity run panel; rows link to the run's thread |
| 5 | Scheduled / upcoming triggers | **Chip only, no new screen** — see disagreement 1 | existing `/agents/triggers` | overdue count as a danger stat on `/ops` |
| 6 | Effective policy | **Ship the member half now, defer the owner half** — see disagreement 2 | `/settings/security` now; `/policy` tab later | rule rows on `/policy` link to the cells they explain |

**Build order** (both reviews ranked #2 first, independently): **audit fix + verify** → run
timing → inference page → runner reap + section → effective policy (member half) → trigger
chip. #2 is the only one where production is *broken*, and the fix is a one-line cast.

## Where they disagreed, and how it was settled

**1. Scheduled/upcoming triggers.** Fable wanted an "Up next" strip; kimix found that
`useTriggersPageState.ts:80` *already* sorts the list soonest-first from plain
`/api/triggers`, so the strip would restate the list directly above itself. **Settled
kimix's way:** no strip. Add only an "Overdue" chip, computed client-side from fields the
page already has (`enabled && active && nextRunAt < now`), plus Fable's overdue count on
`/ops` — a stuck schedule is a worker-sweep symptom, which is the one genuinely new
signal. Both flagged that `/api/triggers/upcoming` is misnamed: it returns
`dueBefore: now`, i.e. *overdue*, not upcoming. It has no consumer and its name lies —
delete it rather than build a screen to justify it, and give `/api/triggers/scheduled` a
`nextRunAt asc` `orderBy` (it has none today) if anything ever consumes it.

**2. Effective policy.** kimix established the endpoint is **not** owner-gated and returns
the *caller's own* decisions. Fable's objection follows: a self-matrix shown to an owner who
passes every check is decoration. Both are right about different audiences. **Settled by
splitting it:** ship the member-facing "Your permissions" matrix on `/settings/security`
now — real value, zero API change, no possible leak because the endpoint is self-scoped —
and defer the owner debugging matrix until someone adds the owner-only `?userId=`
parameter, which is what makes it answer "why can't *they* do X".

**3. Naming only.** `/settings/models` (Fable) vs `/settings/inference-providers` (kimix).
Took `/settings/models` — it names the thing a person is looking for; providers,
credentials and routing profiles are how it is delivered.

## What is explicitly refused

Execution environment templates/instances/leases/usage-ledger (dormant, empty); a standalone
trigger-queue screen (the page already answers it); an owner self-permissions matrix
(decoration); a runner *history* view (deployment archaeology — the reap makes it moot);
putting the execution usage ledger anywhere near `/tokens` (customer-billing surface, repo
law); the raw 120-object dump from `/api/policy/effective` (the matrix is the decision-driver,
not the payload).

## Acceptance for the whole batch

Every item ships with its entry point wired in the same change, or it does not ship — the
failure this batch exists to correct. After the batch, no route in `api/src/routes/` that
returns human-relevant data may have zero callers in `admin/src` without a written
machine-only justification.
