import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom'
import { AgentAvatarQuickEdit } from '../components/features/agents/AgentAvatarQuickEdit'
import { AgentAvatarDraftPanel } from '../components/features/agents/AgentAvatarDraftPanel'
import { AgentDesignerForm } from '../components/features/agents/designer/AgentDesignerForm'
import { DesignerChat } from '../components/features/agents/designer/DesignerChat'
import { useDesignerAssistantPanel } from '../components/features/agents/designer/DesignerAssistantPanelContext'
import { revealDesignerToolCall } from '../components/features/agents/designer/reveal-control'
import type { PageHeaderAction } from '../components/shared/ResponsivePageHeader'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import {
  buildRunLimits,
  readAgentRunLimits,
  runLimitsToForm,
} from '../components/features/agents/designer/run-limits'
import { saveBlockedReason } from '../components/features/agents/designer/save-readiness'
import { QueryState } from '../components/shared/QueryState'
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
import { SectionLabel } from '../components/primitives/SectionLabel'
import { useIsOwner } from '../components/shared/OwnerGate'
import { usePhoneNavigation } from '../layouts/admin-shell/PhoneNavigationProvider'

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
      <QueryState
        className="flex h-full items-center justify-center"
        emptyLabel="Agent not found."
        errorLabel="The agent could not be loaded."
        isEmpty
        loadingLabel="Loading agent…"
        query={agentsQuery}
      >
        {() => null}
      </QueryState>
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
  // `embedded` renders the editor as a panel (no page header, an inline Save
  // bar, no navigation on save) so it can live as the Edit tab inside the agent
  // detail page. `onDone` fires after a successful embedded save.
  embedded?: boolean
  onDone?: () => void
}

export const AgentDesignerContent = ({
  agents,
  editingAgent,
  embedded = false,
  onDone,
}: AgentDesignerContentProps) => {
  const location = useLocation()
  const navigate = useNavigate()
  const navigation = usePhoneNavigation()
  const [searchParams] = useSearchParams()
  const isOwner = useIsOwner()
  const parentId = searchParams.get('parentId') ?? undefined
  const parentAgent = parentId ? agents.find((a) => a.id === parentId) : undefined
  const isEditMode = Boolean(editingAgent)
  const assistantPanel = useDesignerAssistantPanel()
  const assistantCanEditForm = !assistantPanel || assistantPanel.pageContext.title === 'Edit agent'
  const handleAssistantToolCall = useCallback((name: string, args: Record<string, unknown>) => {
    if (!assistantPanel) return false
    if (assistantPanel.actionHandler(name, args)) return true
    // A hidden form must never change while the person is inspecting a
    // different tab. The active page either owns a known action or the model
    // explains that no control is available there.
    return !assistantCanEditForm && [
      'batch_toggle_tools',
      'set_model',
      'set_name',
      'set_role',
      'set_system_prompt',
      'toggle_tool',
    ].includes(name)
  }, [assistantCanEditForm, assistantPanel])
  const handleAssistantToolCallStart = useCallback((name: string) => {
    const formAction = [
      'set_model',
      'set_name',
      'set_role',
      'set_system_prompt',
    ].includes(name)
    if (!assistantCanEditForm && formAction) return true
    revealDesignerToolCall(name)
    return false
  }, [assistantCanEditForm])

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
      todosEnabled: editingAgent.todosEnabled,
      tools: editingAgent.toolPolicy ?? {},
      visibility: editingAgent.visibility ?? 'workspace',
    }
  }, [editingAgent])

  const { actions, clearDraft, state } = useAgentDesigner(initialState, modelOptions, editingAgent?.id)
  const [avatarAttachmentId, setAvatarAttachmentId] = useState<string | undefined>()

  // A new agent cannot be saved without a model, and the Design Assistant may
  // never be asked to pick one. Lead with the catalogue's first entry — Ledger
  // returns it provider-ordered, newest model of each provider first — and
  // never touch a selection that already exists, which is also why edit mode
  // (always seeded from the stored agent) is out.
  const { setModelSelection } = actions
  const leadingModelOption = modelOptions[0]
  useEffect(() => {
    if (isEditMode || state.model || state.provider || !leadingModelOption) return
    setModelSelection(leadingModelOption)
  }, [isEditMode, leadingModelOption, setModelSelection, state.model, state.provider])

  const chat = useDesignerChat(state, actions, toolCatalog.options, modelOptions, {
    onToolCall: handleAssistantToolCall,
    onToolCallStart: handleAssistantToolCallStart,
    pageContext: assistantPanel?.pageContext,
  })
  const createAgent = useCreateAgent()
  const updateAgent = useUpdateAgent()

  const isSaving = createAgent.isPending || updateAgent.isPending
  const selectedModel = modelOptions.find(
    (option) => option.model === state.model && option.provider === state.provider,
  )
  const canSave = Boolean(state.name.trim() && selectedModel && !isSaving)
  const saveBlocker = saveBlockedReason({
    action: isEditMode ? 'save' : 'create',
    hasModel: Boolean(selectedModel),
    hasName: Boolean(state.name.trim()),
  })
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

  // The shared smart Back: an explicit return address wins, else a real
  // previous entry is popped, else the list replaces the cold deep link.
  const handleBack = () => {
    if (navigation) {
      navigation.back({ returnTo, fallback: '/agents' })
      return
    }
    void navigate(returnTo ?? '/agents', { replace: true })
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
        todosEnabled: state.todosEnabled,
        provider: state.provider || undefined,
        model: state.model || undefined,
        toolPolicy,
      })
    } else {
      await createAgent.mutateAsync({
        avatarAttachmentId,
        effort: state.effort,
        name: state.name.trim(),
        role: state.role.trim() || 'assistant',
        runLimits: runLimits ?? undefined,
        systemPrompt: state.systemPrompt.trim() || undefined,
        todosEnabled: state.todosEnabled,
        provider: state.provider || undefined,
        model: state.model || undefined,
        toolPolicy: Object.keys(toolPolicy).length > 0 ? toolPolicy : undefined,
        parentAgentId: parentId,
        visibility: state.visibility,
      })
    }

    // Saved: the form is no longer unsent, so its draft goes.
    clearDraft()

    if (embedded) {
      onDone?.()
      return
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
      ...(saveBlocker ? { title: saveBlocker } : {}),
    },
  ]

  return (
    <div className="flex h-full flex-col">
      {embedded ? (
        <div className="flex flex-shrink-0 items-center justify-end gap-3 border-b border-[color:var(--sep)] px-5 py-2.5">
          <button
            className="admin-button admin-button-primary"
            disabled={!canSave}
            onClick={() => void handleSave()}
            title={saveBlocker ?? undefined}
            type="button"
          >
            {isSaving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      ) : (
        // A Flow that returns to an explicit address the registry cannot
        // know (the list it was opened from), so it owns its Back on every
        // layout rather than deferring to the shared doorway.
        <ScreenHeader
          actions={headerActions}
          backLabel="Back"
          flowOwnsBack
          onBack={handleBack}
          title={isEditMode ? 'Edit Agent' : 'Agent Designer'}
        />
      )}

      {/* The disabled save button is in the header, so its reason sits directly
          under it — a tooltip would leave the dead button unexplained. */}
      {saveBlocker && !isSaving ? (
        <div
          className={[
            'flex-shrink-0 border-b border-[color:var(--sep)] bg-[color:var(--overlay-weak)]',
            'px-5 py-2 text-xs text-[color:var(--tx2)]',
          ].join(' ')}
        >
          {saveBlocker}
        </div>
      ) : null}

      {/* The standalone designer owns its panel. When embedded in agent detail,
          the same panel is portalled into the persistent right rail so it stays
          available as the person moves between the agent's tabs. */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Form panel */}
        <div className="min-h-0 flex-1 overflow-y-auto border-b border-[color:var(--sep)] p-5 lg:flex-[7] lg:border-b-0 lg:border-r">
          <div className="grid gap-5">
            {editingAgent ? (
              <section className="admin-card flex items-center gap-4 p-4">
                <AgentAvatarQuickEdit
                  agent={editingAgent}
                  avatarContext={{
                    name: state.name,
                    role: state.role.trim() || 'assistant',
                    systemPrompt: state.systemPrompt,
                  }}
                  canEdit={isOwner}
                  size="xl"
                />
                <div className="min-w-0">
                  <SectionLabel>Avatar</SectionLabel>
                  <p className="mt-1 text-sm text-[color:var(--tx3)]">
                    Tap the pencil to upload an image or generate a headshot.
                  </p>
                </div>
              </section>
            ) : (
              <AgentAvatarDraftPanel
                avatarAttachmentId={avatarAttachmentId}
                name={state.name}
                onAvatarAttachmentChange={setAvatarAttachmentId}
                role={state.role.trim() || 'assistant'}
              />
            )}
            <AgentDesignerForm
              actions={actions}
              canManageExplicitTools={isOwner}
              canManageTodos={isOwner}
              modelOptions={modelOptions}
              modelOptionsError={modelOptionsError}
              modelsLoading={modelOptionsQuery.isLoading}
              parentAgentName={parentAgent?.name}
              showTools={!isEditMode}
              state={state}
              toolGroups={toolCatalog.groups}
              toolsQuery={toolCatalog}
              visibilityReadOnly={isEditMode}
            />
          </div>
        </div>

        {assistantPanel?.panelOutlet
          ? createPortal(
              <DesignerChat
                error={chat.error}
                messages={chat.messages}
                onClose={assistantPanel.closeDrawer}
                onSend={chat.send}
                onStop={chat.stop}
                pageContext={assistantPanel.pageContext}
                status={chat.status}
                streaming={chat.streaming}
                thinking={chat.thinking}
              />,
              assistantPanel.panelOutlet,
            )
          : !assistantPanel ? (
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
            ) : null}
      </div>
    </div>
  )
}
