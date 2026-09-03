import { KnowledgeProvider, useKnowledge } from '../knowledge/KnowledgeProvider'
import { KnowledgeWorkspace } from '../knowledge/KnowledgeWorkspace'
import { useAgentDocuments } from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { Notice } from '../../primitives/Notice'
import { Pill } from '../../primitives/Pill'
import { EmptyState } from '../../shared/EmptyState'
import { QueryState } from '../../shared/QueryState'
import { useIsOwner } from '../../shared/OwnerGate'

const AgentDocumentsTeam = () => {
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
      <div className="border-b border-[color:var(--sep)] p-3">
        <Notice className="flex flex-wrap items-center gap-2" size="sm" tone="warning">
          <span>These documents are visible to everyone who can see this agent. Don’t store secrets here.</span>
          {!selectedSpace.canWrite ? <Pill tone="warning">Read-only</Pill> : null}
        </Notice>
      </div>
      <div className="min-h-0 flex-1">
        <KnowledgeWorkspace canManageSpace={isOwner} />
      </div>
    </div>
  )
}

export const AgentDocumentsTab = ({ agent }: { agent: AgentRecord }) => {
  const documentsQuery = useAgentDocuments(agent.id)

  return (
    <QueryState
      className="flex h-full items-center justify-center"
      errorLabel="This agent’s documents could not be loaded."
      loadingLabel="Loading documents…"
      query={documentsQuery}
    >
      {() => {
        const space = documentsQuery.data?.space

        if (!space) {
          return (
            <EmptyState>
              {agent.name} has no document space yet. It will appear after the agent first uses its document tools.
            </EmptyState>
          )
        }

        if (!space.canRead) {
          return (
            <EmptyState>
              You can see this agent, but you don’t have access to its documents.
            </EmptyState>
          )
        }

        return (
          <KnowledgeProvider agentId={agent.id} spaceId={space.id}>
            <AgentDocumentsTeam />
          </KnowledgeProvider>
        )
      }}
    </QueryState>
  )
}
