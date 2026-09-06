import type { Prisma } from '@prisma/client'

/**
 * The lock every admission gate takes before it reads the number it is about to
 * decide on.
 *
 * A gate that reads an aggregate, decides, and then admits is correct only while
 * one process is asking. With N replicas the read is stale the instant it
 * returns, and two admitters that each fit alone are both let through. The fix
 * is not a bigger read: it is that the read and the write that makes the
 * admission visible happen inside one transaction that nobody else can
 * interleave with.
 *
 * `pg_advisory_xact_lock` is the right primitive for that because the lock is
 * released by COMMIT or ROLLBACK — a replica killed mid-admission strands
 * nothing. `hashtextextended(name, 0)` maps the human-readable scope name onto
 * the bigint keyspace the function takes; collisions between two unrelated
 * names cost a little contention and never correctness.
 *
 * Blocking, deliberately. `pg_try_advisory_xact_lock` is right for a SWEEP,
 * where "somebody else is already doing this" is a fine answer (see
 * `withSweepLock` in `docs/standards/horizontal-scaling.md` §2). An admission
 * gate has no such answer — refusing because a lock was busy would fail work
 * that fits — so it waits.
 *
 * Waiting is only safe because the guarded section is small. Prisma's
 * interactive transactions time out at 5 s, so a critical section of a couple
 * of indexed reads and one small write leaves room for a queue hundreds deep
 * on one scope. Never put a network call, an object-store write or an unbounded
 * scan inside one of these transactions: that turns the ceiling into a real
 * limit and the queue into failed work.
 */

/** A Prisma handle that may be the client or a `$transaction` client. */
export type AdmissionPrismaClient = Prisma.TransactionClient

export const acquireAdmissionLock = async (
  prisma: AdmissionPrismaClient,
  name: string,
): Promise<void> => {
  // `$executeRaw`, not `$queryRaw`: the function returns `void` and Prisma
  // cannot deserialize a void column.
  await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}::text, 0))`
}
