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

const withFinderQuery = (path: string, search: string): string => {
  const current = new URLSearchParams(search)
  const retained = new URLSearchParams()
  for (const key of ['view', 'sort']) {
    const value = current.get(key)
    if (value) retained.set(key, value)
  }
  const query = retained.toString()
  return query ? `${path}?${query}` : path
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
  search: string
}) => {
  const { dispatch, knowledge, navigate, orgScope, search } = input
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
        return void navigate(withFinderQuery('/knowledge-base/agents', search))
      case 'latest':
        knowledge.selectVirtual('latest')
        return void navigate(withFinderQuery('/knowledge-base/latest', search))
      case 'shared-with-me':
        knowledge.selectVirtual('shared-with-me')
        return void navigate(withFinderQuery('/knowledge-base/shared-with-me', search))
      case 'space':
        knowledge.selectSpace(row.space.spaceId)
        dispatch({ columnKey: `space:${row.space.spaceId}`, type: 'enterColumn' })
        return void navigate(withFinderQuery(
          `/knowledge-base/spaces/${encodeURIComponent(row.space.spaceId)}`,
          search,
        ))
      case 'product-view':
        knowledge.selectProductView(row.view)
        return void navigate(withFinderQuery(
          `/knowledge-base/views/${encodeURIComponent(row.view)}`,
          search,
        ))
    }
  }, [dispatch, knowledge, navigate, search])

  const openAgentHome = useCallback((space: KnowledgeRootSpace) => {
    const agentId = space.ownerAgentId
    if (!agentId) return
    knowledge.selectAgentSpace(agentId, space.spaceId)
    dispatch({ columnKey: `space:${space.spaceId}`, type: 'enterColumn' })
    void navigate(withFinderQuery(`/knowledge-base/agents/${encodeURIComponent(agentId)}`, search))
  }, [dispatch, knowledge, navigate, search])

  const backToRoot = useCallback(() => {
    knowledge.selectVirtual(null)
    void navigate(withFinderQuery('/knowledge-base', search))
  }, [knowledge, navigate, search])
  const backToAgents = useCallback(() => {
    knowledge.selectVirtual('agents')
    void navigate(withFinderQuery('/knowledge-base/agents', search))
  }, [knowledge, navigate, search])

  return {
    agentsDirectoryOpen,
    backToAgents: orgScope && agentsDirectoryOpen ? backToAgents : undefined,
    backToRoot: orgScope ? backToRoot : undefined,
    openAgentHome,
    openRootRow,
    selectedRootRowId,
  }
}
