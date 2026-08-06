import test from 'node:test'

import { Prisma, type PrismaClient } from '@prisma/client'

// Shared support for the worker's Postgres-backed suites.
//
// These suites are different from the rest of the worker tests: they exercise
// the run-serialization invariants, which only exist in the database, and two
// of the functions under test are GLOBAL queue pollers —
// `dispatchNextMailboxMessage` claims the oldest queued mailbox row anywhere in
// the database, and `sweepPendingThreadMessages` drains every orphaned
// (agent, thread) pair anywhere in the database. Neither takes a tenant filter,
// because in production they are the worker's own pollers and the database is
// theirs.
//
// That makes unique per-suite identifiers necessary but NOT sufficient: a
// foreign `queued` mailbox row is claimed ahead of the suite's own, and a
// foreign orphaned pending pair is counted (and drained) by the suite's sweep.
// So the suites in this directory additionally
//   (a) assert only effects scoped to their own seed,
//   (b) refuse to run against a database that already holds rows the pollers
//       would grab (`assertGlobalQueuesQuiet`), and
//   (c) run one file at a time — `pnpm --filter @nessie/worker test:db` passes
//       `--test-concurrency=1`, because two poller-driving files cannot observe
//       each other's rows and still assert their own outcome. This is why they
//       live under `test/db/` rather than beside the unit suites: `test:unit`
//       globs `test/*.test.ts`, so the split is the directory itself.
//
// One file at a time is only exclusivity *within* this package. `@nessie/api`'s
// trigger-dispatch suites pass through the very state the preflight below
// refuses — an orphaned (agent, thread) pending pair — so the two packages must
// not run at once either. `pnpm -r` gets that from its topological order;
// `turbo run test` gets it because `turbo.json` pins `@nessie/api#test` behind
// `@nessie/worker#test`. If this preflight starts failing on a database you
// believe is yours alone, check what else is running against it first.

// Suites are skipped, not failed, when no database is configured: the worker's
// unit suites must stay runnable without Postgres.
export const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const countOf = (rows: { count: bigint }[]): number => Number(rows[0]?.count ?? 0)

// Preflight for the poller-driving suites. Fails fast — and never mutates —
// when the target database already holds rows the global pollers would claim,
// so a shared or real development database produces one actionable error
// instead of a scatter of confusing assertion failures (and never has its own
// mailbox drained or its pending messages force-delivered by a test run).
export const assertGlobalQueuesQuiet = async (prisma: PrismaClient): Promise<void> => {
  const queuedMail = countOf(
    await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "agent_mailbox_messages"
      WHERE "status" = 'queued'::"MailboxMessageStatus"
        AND "visible_at" <= now()
        AND "to_agent_id" IS NOT NULL
    `),
  )
  const orphanedPendingPairs = countOf(
    await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count FROM (
        SELECT DISTINCT p.agent_id, p.thread_id
        FROM run_thread_pending_messages p
        WHERE NOT EXISTS (
          SELECT 1 FROM runs r
          WHERE r.agent_id = p.agent_id
            AND r.thread_id = p.thread_id
            AND r.status IN ('pending', 'running', 'waiting_approval')
        )
      ) AS orphaned
    `),
  )

  if (queuedMail === 0 && orphanedPendingPairs === 0) {
    return
  }

  throw new Error(
    [
      'This suite drives the global queue pollers (dispatchNextMailboxMessage,',
      'sweepPendingThreadMessages), which claim the oldest queued mailbox row and',
      'every orphaned (agent, thread) pending pair in the WHOLE database — so it',
      'needs a database where it is the only actor.',
      '',
      `DATABASE_URL already holds ${queuedMail} queued mailbox message(s) and`,
      `${orphanedPendingPairs} orphaned pending (agent, thread) pair(s).`,
      '',
      'Point DATABASE_URL at a dedicated, freshly migrated test database. Running',
      'against a development database would also dispatch its real mail and',
      'force-deliver its real pending messages.',
    ].join('\n'),
  )
}

// Scoped replacement for `DELETE FROM queue_jobs WHERE idempotency_key LIKE
// 'run:batch:%'` and friends. Those patterns match every suite's jobs, not just
// the caller's, so a cleanup running while another suite asserts its own job
// count silently deletes that job first. The api and worker packages no longer
// overlap under either runner, but every suite still shares the one database
// with its own package's files and with `packages/*`'s database suites. Every
// `run.execute` payload carries a top-level `threadId`, so the seed's thread
// scopes the delete exactly.
export const deleteThreadQueueJobs = async (
  prisma: PrismaClient,
  threadId: string,
): Promise<void> => {
  await prisma
    .$executeRaw(
      Prisma.sql`DELETE FROM queue_jobs WHERE payload->>'threadId' = ${threadId}`,
    )
    .catch(() => undefined)
}
