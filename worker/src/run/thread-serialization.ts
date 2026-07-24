// The claim/pend/drain primitives live in `@nessie/db`
// (`packages/db/src/thread-serialization.ts`) so the API's trigger-dispatch and
// restart paths share the exact same serialization seam. This module re-exports
// them so existing worker call sites (orchestrate, trigger-run, mailbox,
// terminal drain, tests) keep their import path.
export {
  claimThreadRunOrPend,
  drainPendingThreadMessages,
  drainPendingThreadMessagesBestEffort,
  isThreadRunSlotBusy,
  sweepPendingThreadMessages,
  type ThreadRunClaimOutcome,
} from '@nessie/db'
