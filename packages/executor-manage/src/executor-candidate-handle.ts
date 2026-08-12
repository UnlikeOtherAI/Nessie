import { createHash } from 'node:crypto'

/** Store only the digest of an opaque availability choice. */
export const executorCandidateHandleDigest = (handle: string): string =>
  `sha256:${createHash('sha256').update(handle).digest('hex')}`
