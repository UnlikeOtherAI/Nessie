import type { ExecutorAccessViewResponse } from '@nessie/schemas'

import { ExecutorPermittedPrograms } from './ExecutorPermittedPrograms'
import { ExecutorReachableFolders } from './ExecutorReachableFolders'

type DescriptorRevision = NonNullable<ExecutorAccessViewResponse['descriptorRevisions']>[number]

/**
 * What a prepared `descriptor_review` change actually activates.
 *
 * The confirmation card above it renders the stored change verbatim, and that
 * change names a revision number and nothing else. A person confirming it is
 * turning `command.run` on, so the revision's own terms — its profiles, its
 * operations, and the programs it permits — belong beside the confirm control
 * rather than one card further up the page.
 *
 * It renders nothing for any other kind of change, and nothing when the named
 * revision is not among the ones loaded for this executor: an empty block says
 * more truthfully "this card cannot tell you" than a half-filled one would.
 */
export type ExecutorReviewedPolicyProps = {
  change: Record<string, unknown>
  descriptorRevisions?: readonly DescriptorRevision[]
}

/**
 * A prepared change is stored and returned as an opaque record, so the revision
 * a descriptor review activates has to be read back out of it.
 */
export const reviewedDescriptorRevision = (change: Record<string, unknown>): number | null => (
  change.kind === 'descriptor_review'
  && typeof change.revision === 'number'
  && Number.isInteger(change.revision)
    ? change.revision
    : null
)

export const ExecutorReviewedPolicy = ({
  change,
  descriptorRevisions,
}: ExecutorReviewedPolicyProps) => {
  const revisionNumber = reviewedDescriptorRevision(change)
  const revision = revisionNumber === null
    ? undefined
    : (descriptorRevisions ?? []).find((candidate) => candidate.revision === revisionNumber)
  if (!revision) return null
  return (
    <div className="grid gap-1 rounded border border-[color:var(--sep)] p-2 text-xs">
      <p className="font-medium text-[color:var(--tx)]">
        Revision {revision.revision} local policy
      </p>
      <p className="text-[color:var(--tx2)]">
        {revision.profiles.join(', ')} · {revision.operationKeys.join(', ')}
      </p>
      <ExecutorReachableFolders
        operationKeys={revision.operationKeys}
        workspaceFolders={revision.workspaceFolders}
      />
      <ExecutorPermittedPrograms
        commandAllowlist={revision.commandAllowlist}
        operationKeys={revision.operationKeys}
      />
    </div>
  )
}
