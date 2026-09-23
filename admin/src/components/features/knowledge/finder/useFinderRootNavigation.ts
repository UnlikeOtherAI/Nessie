import { useCallback } from 'react'
import type { Dispatch } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import type { KnowledgeRootSpace } from '@nessie/schemas'
import type { KnowledgeSelectedRoot, KnowledgeVirtualKind } from '../useKnowledgeNavigation'
import type { FinderRootRow } from './FinderRootColumn'
import type { FinderSelectionEvent } from './finder-selection'

type FinderRootKnowledge = {
  activeProductView?: string
  selectedRoot: KnowledgeSelectedRoot
  selectAgentSpace: (agentId: string, spaceId: string) => void
  selectProductView: (view: string) => void
  selectSpace: (spaceId: string) => void
  selectVirtual: (kind: KnowledgeVirtualKind | null) => void
}

/**
 * Owns the root directory's route state. Keeping this beside the directory
 * columns makes Agents -> agent home an explicit ancestry instead of a space
 * selection that happens to have arrived through a particular row.
 */
export const useFinderRootNavigation = (input: {
  dispatch: Dispatch<FinderSelectionEvent>
  knowledge: FinderRootKnowledge
  navigate: NavigateFunction
  orgScope: boolean
}) => {
  const { dispatch, knowledge, navigate, orgScope } = input
  const agentsDirectoryOpen = knowledge.selectedRoot?.kind === 'agents'
    || knowledge.selectedRoot?.kind === 'agent-space'
  const selectedRootRowId = knowledge.activeProductView
    ? `view:${knowledge.activeProductView}`
    : knowledge.selectedRoot?.kind === 'latest'
      ? 'virtual:latest'
      : knowledge.selectedRoot?.kind === 'shared-with-me'
        ? 'virtual:shared'
        : agentsDirectoryOpen
          ? 'virtual:agents'
          : knowledge.selectedRoot?.kind === 'space'
            ? knowledge.selectedRoot.spaceId
            : undefined

  const openRootRow = useCallback((row: FinderRootRow) => {
    dispatch({ columnKey: 'root', id: row.id, modifier: 'none', order: [], type: 'click' })
    switch (row.kind) {
      case 'agents':
        knowledge.selectVirtual('agents')
        dispatch({ columnKey: 'virtual:agents', type: 'enterColumn' })
        return void navigate('/knowledge-base/agents')
      case 'latest':
        knowledge.selectVirtual('latest')
        return void navigate('/knowledge-base/latest')
      case 'shared-with-me':
        knowledge.selectVirtual('shared-with-me')
        return void navigate('/knowledge-base/shared-with-me')
      case 'space':
        knowledge.selectSpace(row.space.spaceId)
        dispatch({ columnKey: `space:${row.space.spaceId}`, type: 'enterColumn' })
        return void navigate(`/knowledge-base/spaces/${encodeURIComponent(row.space.spaceId)}`)
      case 'product-view':
        knowledge.selectProductView(row.view)
        return void navigate(`/knowledge-base/views/${encodeURIComponent(row.view)}`)
    }
  }, [dispatch, knowledge, navigate])

  const openAgentHome = useCallback((space: KnowledgeRootSpace) => {
    const agentId = space.ownerAgentId
    if (!agentId) return
    knowledge.selectAgentSpace(agentId, space.spaceId)
    dispatch({ columnKey: `space:${space.spaceId}`, type: 'enterColumn' })
    void navigate(`/knowledge-base/agents/${encodeURIComponent(agentId)}`)
  }, [dispatch, knowledge, navigate])

  const backToRoot = useCallback(() => {
    knowledge.selectVirtual(null)
    void navigate('/knowledge-base')
  }, [knowledge, navigate])
  const backToAgents = useCallback(() => {
    knowledge.selectVirtual('agents')
    void navigate('/knowledge-base/agents')
  }, [knowledge, navigate])

  return {
    agentsDirectoryOpen,
    backToAgents: orgScope && agentsDirectoryOpen ? backToAgents : undefined,
    backToRoot: orgScope ? backToRoot : undefined,
    openAgentHome,
    openRootRow,
    selectedRootRowId,
  }
}
