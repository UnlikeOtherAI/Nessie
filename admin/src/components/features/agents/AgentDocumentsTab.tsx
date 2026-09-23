import { KnowledgeProvider, useKnowledge } from '../knowledge/KnowledgeProvider'
import { KnowledgeWorkspace } from '../knowledge/KnowledgeWorkspace'
import { useAgentDocuments } from '../../../facades/agents/hooks'
import type { AgentRecord } from '../../../lib/api-client'
import { Notice } from '../../primitives/Notice'
import { Pill } from '../../primitives/Pill'
import { EmptyState } from '../../shared/EmptyState'
import { QueryState } from '../../shared/QueryState'
import { useIsOwner } from '../../../facades/auth/hooks'
import type { AgentDocumentsResponse } from '@nessie/schemas'

const ProjectedCoreDocuments = ({
  documents,
}: {
  documents: NonNullable<AgentDocumentsResponse['projectedCoreDocuments']>
}) => (
  <div className="h-full overflow-y-auto p-4">
    <Notice size="sm" tone="neutral">
      This app-provided agent’s required files are code-owned and read-only.
    </Notice>
    <div className="mt-4 space-y-4">
      {documents.map((document) => (
        <section className="rounded-lg border border-[color:var(--sep)] bg-[color:var(--surface)]" key={document.role}>
          <h3 className="border-b border-[color:var(--sep)] px-4 py-3 text-sm font-semibold">
            {document.filename}
          </h3>
          <pre className="whitespace-pre-wrap break-words px-4 py-3 text-sm text-[color:var(--tx2)]">
            {document.markdown || '(Empty)'}
          </pre>
        </section>
      ))}
    </div>
  </div>
)

const AgentDocumentsTeam = ({
  agentId,
  core,
}: {
  agentId: string
  core?: { estimatedTokens: number; state: 'active' | 'oversized'; tokenBudget?: number }
}) => {
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
          <span>
            {core?.state === 'oversized'
              ? `Core instructions estimate ${core.estimatedTokens} tokens, above the ${core.tokenBudget} token limit. Shorten them before the agent can start or resume a run.`
              : 'Published AGENTS.md and personality.md shape every new run. Documents can have narrower access than this agent. Don’t store secrets here.'}
          </span>
          {!selectedSpace.canWrite ? <Pill tone="warning">Read-only</Pill> : null}
        </Notice>
      </div>
      <div className="min-h-0 flex-1">
        <KnowledgeWorkspace
          canManageSpace={isOwner}
          scope={{ agentId, kind: 'agent', spaceId: selectedSpace.id }}
        />
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
        const projected = documentsQuery.data?.projectedCoreDocuments

        if (projected) return <ProjectedCoreDocuments documents={projected} />

        if (!space) {
          return (
            <EmptyState>
              {agent.name}’s required document home is unavailable.
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
            <AgentDocumentsTeam agentId={agent.id} core={documentsQuery.data?.core} />
          </KnowledgeProvider>
        )
      }}
    </QueryState>
  )
}
