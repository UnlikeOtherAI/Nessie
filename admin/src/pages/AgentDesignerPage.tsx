import { useMemo } from 'react'
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import { AgentDesignerForm } from '../components/features/agents/designer/AgentDesignerForm'
import { DesignerChat } from '../components/features/agents/designer/DesignerChat'
import { useAgentDesigner } from '../components/features/agents/designer/useAgentDesigner'
import type { AgentFormState } from '../components/features/agents/designer/useAgentDesigner'
import { useAgents, useCreateAgent, useUpdateAgent } from '../facades/agents/hooks'
import { useDesignerChat } from '../facades/designer/hooks'

const DEFAULT_TOOLS: Record<string, boolean> = {
  'bash': false,
  'file-read': false,
  'file-write': false,
  'glob': false,
  'grep': false,
  'web-search': false,
}

export const AgentDesignerPage = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const { agentId } = useParams<{ agentId?: string }>()
  const [searchParams] = useSearchParams()
  const parentId = searchParams.get('parentId') ?? undefined
  const { data: agents = [] } = useAgents()
  const editingAgent = agentId ? agents.find((a) => a.id === agentId) : undefined
  const parentAgent = parentId ? agents.find((a) => a.id === parentId) : undefined
  const isEditMode = Boolean(agentId)

  const initialState = useMemo<Partial<AgentFormState> | undefined>(() => {
    if (!editingAgent) return undefined
    return {
      name: editingAgent.name,
      role: editingAgent.role,
      provider: editingAgent.provider ?? 'openai',
      model: editingAgent.model ?? 'gpt-5',
      systemPrompt: editingAgent.systemPrompt ?? '',
      tools: DEFAULT_TOOLS,
    }
  }, [editingAgent])

  const { actions, state } = useAgentDesigner(initialState)
  const chat = useDesignerChat(state, actions)
  const createAgent = useCreateAgent()
  const updateAgent = useUpdateAgent()

  const isSaving = createAgent.isPending || updateAgent.isPending

  const returnTo = useMemo(() => {
    const state = location.state
    if (
      state &&
      typeof state === 'object' &&
      'returnTo' in state &&
      typeof state.returnTo === 'string'
    ) {
      return state.returnTo
    }
    return null
  }, [location.state])

  const handleBack = () => {
    const historyIndex =
      typeof window.history.state?.idx === 'number'
        ? window.history.state.idx
        : 0

    if (historyIndex > 0) {
      void navigate(-1)
      return
    }

    if (returnTo) {
      void navigate(returnTo, { replace: true })
      return
    }

    void navigate('/agents', { replace: true })
  }

  const handleSave = async () => {
    if (!state.name.trim()) return

    const enabledTools = Object.fromEntries(
      Object.entries(state.tools).filter(([, v]) => v),
    )

    if (isEditMode && agentId) {
      await updateAgent.mutateAsync({
        agentId,
        name: state.name.trim(),
        role: state.role.trim() || 'assistant',
        systemPrompt: state.systemPrompt.trim() || undefined,
        provider: state.provider || undefined,
        model: state.model || undefined,
        toolPolicy: Object.keys(enabledTools).length > 0 ? state.tools : undefined,
      })
    } else {
      await createAgent.mutateAsync({
        name: state.name.trim(),
        role: state.role.trim() || 'assistant',
        systemPrompt: state.systemPrompt.trim() || undefined,
        provider: state.provider || undefined,
        model: state.model || undefined,
        toolPolicy: Object.keys(enabledTools).length > 0 ? state.tools : undefined,
        parentAgentId: parentId,
      })
    }

    void navigate('/agents')
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-[color:var(--sep)] px-5 py-3">
        <div className="flex items-center gap-3">
          <button
            className={[
              'flex h-8 w-8 items-center justify-center rounded',
              'text-[color:var(--tx3)] transition-colors',
              'hover:bg-white/10 hover:text-white',
            ].join(' ')}
            onClick={handleBack}
            title="Back to agents"
            type="button"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <h1 className="text-base font-bold text-white">
            {isEditMode ? 'Edit Agent' : 'Agent Designer'}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="admin-button admin-button-secondary"
            onClick={handleBack}
            type="button"
          >
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!state.name.trim() || isSaving}
            onClick={handleSave}
            type="button"
          >
            {isSaving
              ? (isEditMode ? 'Saving...' : 'Creating...')
              : (isEditMode ? 'Save Changes' : 'Create Agent')}
          </button>
        </div>
      </div>

      {/* Two-column layout: 70% form, 30% chat */}
      <div className="flex min-h-0 flex-1">
        {/* Form panel */}
        <div className="flex-[7] overflow-y-auto border-r border-[color:var(--sep)] p-5">
          <AgentDesignerForm actions={actions} parentAgentName={parentAgent?.name} state={state} />
        </div>

        {/* Chat panel */}
        <div className="flex-[3] min-w-[280px]">
          <DesignerChat
            error={chat.error}
            messages={chat.messages}
            onSend={chat.send}
            onStop={chat.stop}
            status={chat.status}
            streaming={chat.streaming}
            thinking={chat.thinking}
          />
        </div>
      </div>
    </div>
  )
}
