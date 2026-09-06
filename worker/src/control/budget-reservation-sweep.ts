import type { PrismaClient } from '@prisma/client'
import { deleteSettledBudgetReservations } from '@nessie/runtime'

/**
 * Remove budget reservations whose run has finished.
 *
 * A reservation is dropped by the ledger writer the moment a run records its
 * real spend, which covers every run that spent anything. A run that reached a
 * terminal state without recording usage — blocked at a later gate, cancelled
 * before its first inference, killed mid-claim — leaves its row behind.
 *
 * No claim, no lock, and no leader: the statement is a single idempotent DELETE
 * whose predicate is a terminal run status, so N replicas running it in the same
 * tick simply race to delete the same already-dead rows and the losers delete
 * nothing. That is why this is not one of the sweeps that needs `withSweepLock`
 * (docs/standards/horizontal-scaling.md §2) — there is no multi-step walk to
 * duplicate.
 *
 * It frees rows, never budget: the admission aggregate already ignores a
 * reservation whose run is terminal, so a crashed run cannot hold budget hostage
 * in the window before this runs.
 */
export const sweepSettledBudgetReservations = async (
  prisma: PrismaClient,
): Promise<number> => deleteSettledBudgetReservations(prisma)
