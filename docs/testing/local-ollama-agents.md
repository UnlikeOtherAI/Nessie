# Local Ollama agents — verification record

This capability is an explicit `local_device` generative lane for a
person-owned agent on that same person's host. It is not the older
`delegate_local` executor tool proposal. The worker retains prompt assembly,
tool authorization, approvals, disclosure, checkpoints and messages; a local
host is only a bounded inference processor.

## Safety checks currently exercised

From the repository root, with dependencies installed:

```powershell
pnpm --filter @nessie/executor exec node --test --import tsx test/ollama-observed.test.ts
pnpm --filter @nessie/runtime exec node --test --import tsx test/uoa-live-entitlements.test.ts
pnpm --filter @nessie/runtime exec node --test --import tsx test/local-inference-policy.test.ts
pnpm --filter @nessie/admin exec node --test --import tsx test/local-inference-run-restart.test.ts
```

Results on 2026-09-20:

- `ollama-observed.test.ts`: 4 passed — read-only tags/show discovery, official
  remote markers, changed output digest, malformed/oversized observations.
- `uoa-live-entitlements.test.ts`: 6 passed — active link, authoritative denial
  and unavailable UOA authority remain distinct.
- `local-inference-policy.test.ts`: 2 passed — only the typed setting key is
  administrator-authored and its value is a boolean.
- `local-inference-run-restart.test.ts`: 2 passed — only an exact,
  server-authored local-host failure may render the fresh-run Restart control;
  malformed metadata cannot create it.

The general type checks run through the workspace packages. The admin package
currently cannot complete in this checkout because the pre-existing private
`@unlikeotherai/billing-statement-protocol` dependency is unavailable; its
errors are confined to billing files, not the Local Ollama components.

## Required release-gate coverage

The complete release suite must additionally run with `DATABASE_URL` explicitly
set and through Turbo, for example:

```powershell
$env:DATABASE_URL = 'postgresql://nessie:nessie@127.0.0.1:5432/nessie_test'
pnpm exec turbo run test --filter=@nessie/api --filter=@nessie/worker --filter=@nessie/executor
pnpm --filter @nessie/worker build
```

It must include the reconciled stop-ship matrix: missing provider provenance,
UOA denied versus unavailable, Save/consent/policy races, host key rotation,
remote Ollama markers, endpoint conflict, receipt expiry/replay, malicious tool
calls, upgrade rollback fencing and a no-op capability smoke. Browser and
native work must be inspected in headless Playwright; screenshots belong under
`e2e/screenshots/local-ollama-agents/`. Windows verification does not establish
macOS or Linux native support.

## Real Ollama boundary

Do not pull, delete, alter configuration, stop, or otherwise mutate a person's
Ollama installation. A real-device check is read-only and only follows product
consent: list the selected literal loopback endpoint and make the bounded
synthetic no-op inference/tool probe. This record intentionally makes no claim
that a real installed model was exercised.
