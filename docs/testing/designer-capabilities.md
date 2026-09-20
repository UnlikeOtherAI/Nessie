# Agent Designer capability and output recovery evaluation

This evaluation uses the real API, embedded worker and admin chat with scripted
inference. It creates one isolated local organisation, its owner, a CTO agent,
and the owner's Agent Designer home. It does not use production data or claim
to prove live-model reasoning quality.

Use an isolated, migrated PostgreSQL database and built workspace dependencies:

```sh
DATABASE_URL=postgresql://nessie:nessie@127.0.0.1:56532/nessie_designer \
NESSIE_API_PORT=5468 NESSIE_ADMIN_PORT=5469 \
pnpm --filter @nessie/admin test:e2e:designer-capabilities
```

The harness refuses to adopt existing API or admin processes. Servers use the
repository's shared port resolver, and Chromium runs headless. Screenshots and
the result record are written to `e2e/screenshots/designer-capabilities/`.

The owner submits a Czech request through the rendered conversation composer.
Designer reads exact tool schemas from private context, inspects target access,
grants protected browser access, and changes the target's voice. Scripted
reasoning then returns `finish_reason=length` without a visible answer. The
evaluation requires a successful automatic recovery, a useful final answer on
desktop and phone, one execution of each mutation, and no false token-budget
event or manual Continue message. A second conversation revokes the grant;
the stored policy and rendered answer persist after reload while the unrelated
voice setting remains unchanged.

Service and worker regressions separately cover unauthorized callers, private
and cross-organisation targets, consent boundaries, DeepWater bundle consistency,
genuine budgets, and bounded repeated provider failure.

## Recorded local verification

The desktop and phone evaluation passed on 2026-09-20. The real API and worker
executed schema lookup, inspection, browser grant, voice update and revocation;
the scripted provider returned one empty, truncated 2,048-token response. The
same run completed with a visible answer, no repeated mutations and no token
budget exhaustion event. Screenshots were visually inspected in both layouts.

The real-database DeepWater regression first failed against the original
implementation because policy entries created no descriptor-bound grants. It
now verifies all five MCP grants, stale descriptor rejection, re-grant and
explicit revocation, alongside the builtin updater dependency.

Local API tests that import the worker require an isolated encryption key ring,
matching CI's test environment. This is test setup; production keys are never
used for these evaluations.
