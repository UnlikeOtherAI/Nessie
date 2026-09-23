import type { KnowledgeRoot, KnowledgeRootSpace } from '@nessie/schemas'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { prewarmRowHandlers, usePrewarm } from '../../../../navigation/prewarm'
import { AgentAvatar } from '../../../shared/AgentAvatar'
import { EmptyState } from '../../../shared/EmptyState'
import { QueryState } from '../../../shared/QueryState'
import { RowList } from '../../../shared/RowList'
import { Skeleton } from '../../../primitives/Skeleton'
import { FinderRow } from './FinderRow'
import { agentDocumentsSpaceDisplayName } from './agent-space-name'

type FinderAgentsColumnProps = {
  activeAgentId?: string
  columnActive: boolean
  onOpen: (space: KnowledgeRootSpace) => void
  query: { isError: boolean; isLoading: boolean; refetch: () => unknown }
  root?: KnowledgeRoot
}

/**
 * The one directory behind the root's Agents doorway. Agent homes remain real
 * spaces (so uploads, Move/Copy and nested files reuse the same Finder), but
 * they no longer consume one root-menu row each.
 */
export const FinderAgentsColumn = ({
  activeAgentId,
  columnActive,
  onOpen,
  query,
  root,
}: FinderAgentsColumnProps) => {
  const { token } = useAuthSession()
  const prewarm = usePrewarm()
  const homes = root?.agentHomes ?? []

  return (
    <QueryState
      className="py-6"
      errorLabel="Couldn’t load agent documents."
      loadingLabel="Loading agents…"
      query={query}
    >
      {() => root === undefined ? (
        <Skeleton count={5} variant="list" />
      ) : homes.length === 0 ? (
        <EmptyState>No agent document homes are available.</EmptyState>
      ) : (
        <>
          <RowList label="Agents" role="listbox" variant="finder">
            {homes.map((space) => {
              const agentId = space.ownerAgentId
              if (!agentId) return null
              const destination = `/knowledge-base/agents/${encodeURIComponent(agentId)}`
              return (
                <FinderRow
                  ariaLabel={`${agentDocumentsSpaceDisplayName(space.name)} documents`}
                  chevron
                  columnActive={columnActive}
                  id={agentId}
                  key={space.spaceId}
                  kind="space"
                  leading={<AgentAvatar agentId={agentId} size={20} token={token} />}
                  locked={space.writeRestricted}
                  onOpen={() => onOpen(space)}
                  prewarm={prewarmRowHandlers(prewarm, destination)}
                  selected={activeAgentId === agentId}
                  tabIndex={(activeAgentId ?? homes[0]?.ownerAgentId) === agentId ? 0 : -1}
                  title={agentDocumentsSpaceDisplayName(space.name)}
                  variant="root"
                />
              )
            })}
          </RowList>
          {root.agentHomesTruncated ? (
            <p className="px-3 py-2 text-xs text-[color:var(--tx3)]">
              Showing the first 200 accessible agents.
            </p>
          ) : null}
        </>
      )}
    </QueryState>
  )
}
