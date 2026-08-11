import { useMemo } from 'react'
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import { AgentAvatarPanel } from '../components/features/agents/AgentAvatarPanel'
import { AgentDesignerForm } from '../components/features/agents/designer/AgentDesignerForm'
import { DesignerChat } from '../components/features/agents/designer/DesignerChat'
import {
  ResponsivePageHeader,
  type PageHeaderAction,
} from '../components/shared/ResponsivePageHeader'
import {
  buildRunLimits,
  readAgentRunLimits,
  runLimitsToForm,
} from '../components/features/agents/designer/run-limits'
import { useAgentDesigner } from '../components/features/agents/designer/useAgentDesigner'
import type { AgentFormState } from '../components/features/agents/designer/useAgentDesigner'
import {
  useAgentModelOptions,
  useAgents,
  useCreateAgent,
  useUpdateAgent,
} from '../facades/agents/hooks'
import { useDesignerChat } from '../facades/designer/hooks'
import { buildToolPolicy, useDesignerToolCatalog } from '../facades/designer/tool-catalog'
import type { AgentRecord } from '../lib/api-client'
import { useAuthSession } from '../providers/AuthSessionProvider'

export const AgentDesignerPage = () => {
  const { agentId } = useParams<{ agentId?: string }>()
  const agentsQuery = useAgents()
  const agents = agentsQuery.data ?? []
  const editingAgent = agentId ? agents.find((a) => a.id === agentId) : undefined
  const isEditMode = Boolean(agentId)

  // The reducer inside the designer initialises once, so wait for the agent
  // record before mounting it in edit mode (deep links load agents async) and
  // remount whenever the target agent changes.
  if (isEditMode && !editingAgent) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]">
        {agentsQuery.isLoading ? 'Loading agent…' : 'Agent not found.'}
      </div>
    )
  }

  return (
    <AgentDesignerContent
      agents={agents}
      editingAgent={editingAgent}
      key={agentId ?? 'new'}
    />
  )
}

type AgentDesignerContentProps = {
  agents: AgentRecord[]
  editingAgent?: AgentRecord
}

const AgentDesignerContent = ({ agents, editingAgent }: AgentDesignerContentProps) => {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const parentId = searchParams.get('parentId') ?? undefined
  const parentAgent = parentId ? agents.find((a) => a.id === parentId) : undefined
  const isEditMode = Boolean(editingAgent)

  const toolCatalog = useDesignerToolCatalog(isOwner)
  const modelOptionsQuery = useAgentModelOptions()
  const modelOptions = modelOptionsQuery.data ?? []

  const initialState = useMemo<Partial<AgentFormState> | undefined>(() => {
    if (!editingAgent) return undefined
    return {
      effort: editingAgent.effort ?? 'medium',
      name: editingAgent.name,
      role: editingAgent.role,
      provider: editingAgent.provider ?? '',
      model: editingAgent.model ?? '',
      runLimits: runLimitsToForm(readAgentRunLimits(editingAgent)),
      systemPrompt: editingAgent.systemPrompt ?? '',
      tools: editingAgent.toolPolicy ?? {},
    }
  }, [editingAgent])

  const { actions, state } = useAgentDesigner(initialState)
  const chat = useDesignerChat(state, actions, toolCatalog.options)
  const createAgent = useCreateAgent()
  const updateAgent = useUpdateAgent()

  const isSaving = createAgent.isPending || updateAgent.isPending
  const selectedModel = modelOptions.find(
    (option) => option.model === state.model && option.provider === state.provider,
  )
  const canSave = Boolean(state.name.trim() && selectedModel && !isSaving)
  const modelOptionsError = modelOptionsQuery.error instanceof Error
    ? modelOptionsQuery.error.message
    : modelOptionsQuery.isError
      ? 'Ledger models could not be loaded.'
      : undefined

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
    if (!state.name.trim() || !selectedModel) return

    const toolPolicy = buildToolPolicy(toolCatalog.options, state.tools)
    // All fields blank sends an explicit `null`, which clears any stored limits.
    const runLimits = buildRunLimits(state.runLimits)

    if (isEditMode && editingAgent) {
      await updateAgent.mutateAsync({
        agentId: editingAgent.id,
        effort: state.effort,
        name: state.name.trim(),
        role: state.role.trim() || 'assistant',
        runLimits,
        systemPrompt: state.systemPrompt.trim() || undefined,
        provider: state.provider || undefined,
        model: state.model || undefined,
        toolPolicy,
      })
    } else {
      await createAgent.mutateAsync({
        effort: state.effort,
        name: state.name.trim(),
        role: state.role.trim() || 'assistant',
        runLimits: runLimits ?? undefined,
        systemPrompt: state.systemPrompt.trim() || undefined,
        provider: state.provider || undefined,
        model: state.model || undefined,
        toolPolicy: Object.keys(toolPolicy).length > 0 ? toolPolicy : undefined,
        parentAgentId: parentId,
      })
    }

    void navigate('/agents')
  }
  const headerActions: PageHeaderAction[] = [
    {
      id: 'cancel',
      label: 'Cancel',
      onSelect: handleBack,
      priority: 60,
    },
    {
      disabled: !canSave,
      id: 'save-agent',
      label: isSaving
        ? (isEditMode ? 'Saving...' : 'Creating...')
        : (isEditMode ? 'Save changes' : 'Create agent'),
      onSelect: () => void handleSave(),
      primary: true,
      priority: 100,
    },
  ]

  return (
    <div className="flex h-full flex-col">
      <ResponsivePageHeader
        actions={headerActions}
        onBack={handleBack}
        title={isEditMode ? 'Edit Agent' : 'Agent Designer'}
      />

      {/* Two-column layout: 70% form, 30% chat */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Form panel */}
        <div className="min-h-0 flex-1 overflow-y-auto border-b border-[color:var(--sep)] p-5 lg:flex-[7] lg:border-b-0 lg:border-r">
          <div className="grid gap-5">
            {editingAgent ? <AgentAvatarPanel agent={editingAgent} /> : null}
            <AgentDesignerForm
              actions={actions}
              canManageExplicitTools={isOwner}
              modelOptions={modelOptions}
              modelOptionsError={modelOptionsError}
              modelsLoading={modelOptionsQuery.isLoading}
              parentAgentName={parentAgent?.name}
              state={state}
              toolGroups={toolCatalog.groups}
              toolsLoading={toolCatalog.isLoading}
            />
          </div>
        </div>

        {/* Chat panel */}
        <div className="h-[360px] min-h-[320px] lg:h-auto lg:flex-[3] lg:min-w-[280px]">
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
