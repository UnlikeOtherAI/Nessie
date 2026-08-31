import type { RunStatus } from '@prisma/client'

/**
 * A to-do's active run is live until it reaches one of these statuses.
 *
 * Keep the liveness definition shared by claims and agent step writes so a
 * newly terminal run cannot leave a stale activeRunId pointer behind.
 */
export const TERMINAL_RUN_STATUSES: RunStatus[] = ['completed', 'failed', 'cancelled']
