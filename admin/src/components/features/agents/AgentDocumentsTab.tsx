import { KnowledgeProvider, useKnowledge } from '../knowledge/KnowledgeProvider'
import { KnowledgeWorkspace } from '../knowledge/KnowledgeWorkspace'
import { useAgentDocuments } from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { EmptyState } from '../../shared/EmptyState'
import { useIsOwner } from '../../shared/OwnerGate'

const AgentDocumentsWorkspace = () => {
  const isOwner = useIsOwner()
  const { selectedSpace, spacesLoaded, spacesLoadFailed } = useKnowledge()

  if (spacesLoadFailed) {
    return <EmptyState>This document space is not available.</EmptyState>
  }
  if (!spacesLoaded || !selectedSpace) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]">
        Loading documents…
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--sep)] bg-[color:var(--warning-soft)] px-4 py-2 text-xs text-[color:var(--warning-text)]">
        <span>These documents are visible to everyone who can see this agent. Don’t store secrets here.</span>
        {!selectedSpace.canWrite ? (
          <span className="rounded-full border border-current px-2 py-0.5 font-semibold">Read-only</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <KnowledgeWorkspace canManageSpace={isOwner} />
      </div>
    </div>
  )
}

export const AgentDocumentsTab = ({ agent }: { agent: AgentRecord }) => {
  const documentsQuery = useAgentDocuments(agent.id)

  if (documentsQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]">
        Loading documents…
      </div>
    )
  }
  if (documentsQuery.isError) {
    return <EmptyState>Could not load this agent’s documents.</EmptyState>
  }
  if (!documentsQuery.data?.space) {
    return (
      <EmptyState>
        {agent.name} has no document space yet. It will appear after the agent first uses its document tools.
      </EmptyState>
    )
  }

  return (
    <KnowledgeProvider agentId={agent.id} spaceId={documentsQuery.data.space.id}>
      <AgentDocumentsWorkspace />
    </KnowledgeProvider>
  )
}
