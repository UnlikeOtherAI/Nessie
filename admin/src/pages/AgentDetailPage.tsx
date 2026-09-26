import { useMemo } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { AgentPage } from '../components/features/agents/page/AgentPage'
import { NewAgentFlow } from '../components/features/agents/page/NewAgentFlow'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { useAgents } from '../facades/agents/hooks'
import { usePhoneNavigation } from '../layouts/admin-shell/PhoneNavigationProvider'

const AGENTS_PATH = '/admin/agents'

/**
 * `/admin/agents/:agentId` — one agent's page, reached from the agents list,
 * a conversation, an app's or a computer's agent rows, and every link an
 * agent's own tools write.
 *
 * `/admin/agents/:id` is a real depth-2 route whose parent is Agents (the
 * surface registry), so the shared Back already returns to the list; this page
 * registers no local Back of its own, which would outrank the Knowledge stages
 * inside its Instructions tab. On a wide layout the header's Back pops to the
 * list entry the person left, `?scope=` and all, rather than pushing a bare one.
 */
export const AgentDetailPage = () => {
  const navigate = useNavigate()
  const navigation = usePhoneNavigation()
  const { agentId } = useParams<{ agentId?: string }>()
  // `scope: 'all'` so a built-in agent (or a helper another agent started)
  // resolves too — the same list the Agents page renders.
  const agentsQuery = useAgents({ scope: 'all' })
  const agent = agentId ? agentsQuery.data?.find((candidate) => candidate.id === agentId) : undefined
  const onBack = () => {
    if (navigation) {
      navigation.performBack()
      return
    }
    void navigate(AGENTS_PATH)
  }

  if (!agent) {
    // The header is rendered here too: loading, failure and not-found are
    // states of this screen, and a phone with no header has no Back at all.
    return (
      <div className="flex h-full flex-col">
        <ScreenHeader backLabel="Back to Agents" onBack={onBack} title="Agent" />
        <QueryState
          className="flex flex-1 items-center justify-center"
          emptyLabel="This agent could not be found. It may have been deleted, or it is not shared with you."
          errorLabel="Agents could not be loaded."
          isEmpty
          loadingLabel="Loading agent…"
          query={agentsQuery}
        >
          {() => null}
        </QueryState>
      </div>
    )
  }

  return <AgentPage agent={agent} onBack={onBack} />
}

/**
 * `/admin/agents/new` — New agent, a Flow over wherever it was opened from:
 * the Create menu, the agents list, a channel's Agents tab, the workflow
 * designer. Back returns to that exact place when it came with one, else to
 * the previous entry, else to Agents; a created agent replaces the flow with
 * its own page, so Back from there lands where New agent was pressed.
 */
export const NewAgentPage = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const navigation = usePhoneNavigation()
  const returnTo = useMemo(() => {
    const state: unknown = location.state
    return state && typeof state === 'object' && 'returnTo' in state && typeof state.returnTo === 'string'
      ? state.returnTo
      : null
  }, [location.state])
  const onBack = () => {
    if (navigation) {
      navigation.back({ fallback: AGENTS_PATH, returnTo })
      return
    }
    void navigate(returnTo ?? AGENTS_PATH, { replace: true })
  }
  return (
    <NewAgentFlow
      onBack={onBack}
      onCreated={(agent) => void navigate(`${AGENTS_PATH}/${agent.id}`, { replace: true })}
    />
  )
}
