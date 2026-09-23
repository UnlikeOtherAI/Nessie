import type { ExecutorDescriptorRevisionView } from '../../../facades/executors/local-mcp'
import { ExecutorCodingAgents } from './ExecutorCodingAgents'
import { ExecutorMcpServers } from './ExecutorMcpServers'
import { ExecutorPermittedPrograms } from './ExecutorPermittedPrograms'
import { ExecutorReachableFolders } from './ExecutorReachableFolders'
import { executorOperationLabel } from './executor-presentation'

/**
 * What a prepared `descriptor_review` change actually activates.
 *
 * The stored change names a revision number and nothing else. A person confirming it is
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
  descriptorRevisions?: readonly ExecutorDescriptorRevisionView[]
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
  return <ExecutorPermissionDetails revision={revision} />
}

/** The same readable terms appear on the machine and in its approval. */
export const ExecutorPermissionDetails = ({ revision }: { revision: ExecutorDescriptorRevisionView }) => (
    <div className="grid gap-3 text-sm text-[color:var(--tx2)]">
      <ul className="grid gap-1">
        {revision.operationKeys.map((key) => <li key={key}>{executorOperationLabel(key)}</li>)}
      </ul>
      <ExecutorReachableFolders
        operationKeys={revision.operationKeys}
        workspaceFolders={revision.workspaceFolders}
      />
      <ExecutorMcpServers
        mcpServers={revision.mcpServers}
        operationKeys={revision.operationKeys}
      />
      <ExecutorCodingAgents codingSessions={revision.codingSessions} />
      <ExecutorPermittedPrograms
        commandAllowlist={revision.commandAllowlist}
        operationKeys={revision.operationKeys}
      />
      {revision.operationKeys.includes('browser.open') ? (
        <p>Browser access is limited to sites approved on the machine.</p>
      ) : null}
      {revision.operationKeys.includes('coding.launch') ? (
        <p>Coding runs in an isolated copy. Login details stay on the machine.</p>
      ) : null}
    </div>
)
