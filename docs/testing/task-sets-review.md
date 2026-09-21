# Task Sets implementation review

The authoritative behavior is [Sequential task sets](../standards/task-sets.md).
Kimix reviewed the item admission, step journal and settlement implementation
as an adviser. The implementing agent assessed each finding against the actual
transaction boundaries; this review did not delegate design authority.

## Accepted findings

- Health updates occurred after the result transaction and could overwrite a
  successor's newer state. Settlement now writes health, alerts and the next
  wakeup inside the same fenced transaction as item/run/cursor changes.
- Pending completion was serialized into a reason field. Attempts now have a
  dedicated, schema-validated `pendingOutcome` receipt. Confirmation recovery
  reads that receipt without repeating inference.

## Findings not adopted

- Resource reservations were alleged to commit outside admission. The helper
  receives the caller's Prisma transaction; reservation and item admission
  commit or roll back together.
- A null claim was alleged to finalize paused/incomplete work. Finalization
  independently locks the set and requires sealed input, an eligible state and
  only completed/skipped items.
- A failed attempt's journal was alleged to poison every later retry. Journal
  identity includes the attempt id; an explicit retry creates a distinct
  attempt. An unknown outcome in the same attempt deliberately blocks a hosted
  request whose remote execution cannot be disproved.
- An uncommitted release was alleged to permit another admission. PostgreSQL
  does not expose that uncommitted state; the resource advisory lock also
  serializes admission.
- Pause was alleged to discard a confirmed successful result. Settlement
  retains the result and advances its cursor while leaving the set paused or
  cancelled, without admitting another item.

## Additional integrated review

Local receipt recovery now checks completed receipts before generation
deadlines and can recover the pinned request after a host reconnect or while
the host is offline. It retains live owner, consent and source checks. A sweep
no longer moves `nextAttemptAt` into the future before delivering its wakeup.
Both fixes have focused recovery regressions.

Spreadsheet mapping and cell limits use the same validator before item
completion and during artifact rendering. Delivery has a separate status from
completed processing. Native result readers and receiver dispatch revalidate
the reading agent's current source permissions as well as the responsible
human's access. Failed delivery retains the completed output.

## Verification boundaries

The durable tests cover database races, stale fences, dependency order,
offline alerts, interruption versus failure allowances, confirmed resource
release, output receipts, source permissions and independent receiver retries.
A mock HTTP model exercises the production processor transport, sequential
cursor, dependency input, result mapping and artifact finalization. Browser
fixtures exercise the production interface separately.

These checks do not measure live Ollama answer quality, an installed Mac's
memory use, search-account availability, or an 80,000-prompt live run. Large
file tests exercise deterministic import and export, not model throughput.
