import { useNavigate, useSearchParams } from 'react-router-dom'
import { AgentDesignerForm } from '../components/features/agents/designer/AgentDesignerForm'
import { DesignerChat } from '../components/features/agents/designer/DesignerChat'
import { useAgentDesigner } from '../components/features/agents/designer/useAgentDesigner'
import { useAgents, useCreateAgent } from '../facades/agents/hooks'
import { useDesignerChat } from '../facades/designer/hooks'

export const AgentDesignerPage = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const parentId = searchParams.get('parentId') ?? undefined
  const { data: agents = [] } = useAgents()
  const parentAgent = parentId ? agents.find((a) => a.id === parentId) : undefined
  const { actions, state } = useAgentDesigner()
  const chat = useDesignerChat(state, actions)
  const createAgent = useCreateAgent()

  const handleSave = async () => {
    if (!state.name.trim()) return

    const enabledTools = Object.fromEntries(
      Object.entries(state.tools).filter(([, v]) => v),
    )

    await createAgent.mutateAsync({
      name: state.name.trim(),
      role: state.role.trim() || 'assistant',
      systemPrompt: state.systemPrompt.trim() || undefined,
      provider: state.provider || undefined,
      model: state.model || undefined,
      toolPolicy: Object.keys(enabledTools).length > 0 ? state.tools : undefined,
      parentAgentId: parentId,
    })

    void navigate('/agents')
  }

  const handleCancel = () => {
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
            onClick={handleCancel}
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
          <h1 className="text-base font-bold text-white">Agent Designer</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="admin-button admin-button-secondary"
            onClick={handleCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!state.name.trim() || createAgent.isPending}
            onClick={handleSave}
            type="button"
          >
            {createAgent.isPending ? 'Creating...' : 'Create Agent'}
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
            streaming={chat.streaming}
            thinking={chat.thinking}
          />
        </div>
      </div>
    </div>
  )
}
