import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAgentModelOptions, useCreateAgent, useUpdateAgent } from '../../../../facades/agents/hooks'
import { useIsOwner } from '../../../../facades/auth/hooks'
import { formErrorMessage } from '../../../../facades/forms/form-errors'
import { buildRunLimits, readAgentRunLimits, runLimitsToForm } from '../../../../facades/designer/run-limits'
import { buildToolPolicy, useDesignerToolCatalog } from '../../../../facades/designer/tool-catalog'
import type { AgentFormState, AgentVisibilityValue } from '../../../../facades/designer/types'
import type { AgentModelOption, AgentRecord } from '../../../../lib/api-client'
import { findModelOption, modelOptionSource } from '../designer/model-options'
import { saveBlockedReason } from '../designer/save-readiness'
import { useAgentDesigner } from '../designer/useAgentDesigner'

/** The two canonical documents the form edits as its instructions and manner. */
export type AgentCoreDocument = { markdown: string; role: 'identity' | 'working_rules' }

type AgentConfigFormInput = {
  /** The stored agent being edited; absent for a new one. */
  agent?: AgentRecord
  /** `AGENTS.md` and `personality.md` as published, when this reader may read them. */
  coreDocuments?: readonly AgentCoreDocument[]
  /** The audience a new agent starts with, when the doorway already chose one. */
  initialVisibility?: AgentVisibilityValue
}

// The fields an edit saves. Tools are not among them: an existing agent's
// tools have their own writer on the Access tab (it alone may reach the
// protected grants), so the form never sends a policy it did not change.
const SAVED_FIELDS = [
  'effort',
  'localInferenceHostId',
  'localManifestDigest',
  'model',
  'modelSubscriptionId',
  'name',
  'provider',
  'role',
  'runLimits',
  'speakingStyle',
  'systemPrompt',
  'todosEnabled',
  'voiceName',
] as const satisfies ReadonlyArray<keyof AgentFormState>

const differs = (left: AgentFormState, right: Partial<AgentFormState>): boolean =>
  SAVED_FIELDS.some((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]))

/**
 * One agent's configuration as a form: what the Instructions and Settings tabs
 * edit, what the create flow fills in, and the one Save behind both.
 *
 * It is the designer's reducer and draft (`useAgentDesigner`) with the page's
 * decisions around it — where the form starts from, which model a new agent
 * leads with, what may be saved and what saving sends. The Design Assistant
 * writes into the same reducer, so a change it makes is a change on this form.
 */
export const useAgentConfigForm = ({
  agent,
  coreDocuments,
  initialVisibility,
}: AgentConfigFormInput) => {
  const isOwner = useIsOwner()
  const isEdit = Boolean(agent)
  // A new agent's tools are part of this form; an edit keeps the catalogue so
  // the assistant is told the policy the agent actually has.
  const toolCatalog = useDesignerToolCatalog(isOwner)
  const modelOptionsQuery = useAgentModelOptions(agent?.id)
  const allModelOptions = modelOptionsQuery.data
  // Native consent names an existing person-owned agent, so a new agent starts
  // on an ordinary model and its Model field becomes the local doorway later.
  const modelOptions = useMemo<AgentModelOption[]>(
    () => (isEdit
      ? allModelOptions ?? []
      : (allModelOptions ?? []).filter((option) => modelOptionSource(option) !== 'local')),
    [allModelOptions, isEdit],
  )

  const initialState = useMemo<Partial<AgentFormState> | undefined>(() => {
    if (!agent) return initialVisibility ? { visibility: initialVisibility } : undefined
    return {
      effort: agent.effort ?? 'medium',
      localInferenceHostId: '',
      localManifestDigest: '',
      model: agent.model ?? '',
      // Which linked account the agent already spends, so an edit that never
      // touches the model cannot re-point it at another one.
      modelSubscriptionId: agent.modelSubscriptionId ?? '',
      name: agent.name,
      provider: agent.provider ?? '',
      role: agent.role,
      runLimits: runLimitsToForm(readAgentRunLimits(agent)),
      speakingStyle: coreDocuments?.find((document) => document.role === 'working_rules')?.markdown
        ?? agent.speakingStyle ?? '',
      systemPrompt: coreDocuments?.find((document) => document.role === 'identity')?.markdown
        ?? agent.systemPrompt ?? '',
      todosEnabled: agent.todosEnabled,
      tools: agent.toolPolicy ?? {},
      visibility: agent.visibility ?? 'team',
      voiceName: agent.voiceName ?? '',
    }
  }, [agent, coreDocuments, initialVisibility])

  const { actions, clearDraft, markSaved, state } = useAgentDesigner(
    initialState, modelOptions, agent?.id, toolCatalog.options,
  )
  const [avatarAttachmentId, setAvatarAttachmentId] = useState<string | undefined>()
  const [localBindingId, setLocalBindingId] = useState<string | null>(
    agent?.provider === 'local/ollama' ? agent.localInferenceBindingId ?? null : null,
  )
  const [saveError, setSaveError] = useState<string | null>(null)

  // A new agent cannot be saved without a model, and the Design Assistant is
  // never asked to pick one. Lead with the catalogue's first model-service
  // entry — never the picker's first row, which is the person's own plan: a
  // default nobody chose must not spend somebody's personal subscription.
  const { setModelSelection, setVisibility, dispatch } = actions
  const leadingModel = modelOptions.find((option) => modelOptionSource(option) === 'ledger')
    ?? modelOptions[0]
  useEffect(() => {
    if (isEdit || state.model || state.provider || !leadingModel) return
    setModelSelection(leadingModel)
  }, [isEdit, leadingModel, setModelSelection, state.model, state.provider])

  // An explicit doorway choice wins over a restored draft once, on arrival.
  useEffect(() => {
    if (initialVisibility) setVisibility(initialVisibility)
  }, [initialVisibility, setVisibility])

  // The Access tab saves an existing agent's tools on its own; the form only
  // mirrors the stored policy, so the assistant reasons about the real one.
  const storedTools = agent?.toolPolicy
  useEffect(() => {
    if (storedTools) dispatch({ toolState: storedTools, type: 'set_tool_selection' })
  }, [dispatch, storedTools])

  const createAgent = useCreateAgent()
  const updateAgent = useUpdateAgent()
  const isSaving = createAgent.isPending || updateAgent.isPending

  const selectedModel = findModelOption(
    modelOptions,
    state.model,
    state.provider,
    state.modelSubscriptionId,
    state.localInferenceHostId,
    state.localManifestDigest,
  )
  const localSelection = selectedModel?.source === 'local'
  const blocker = localSelection && !localBindingId
    ? 'Approve this local model before saving.'
    : saveBlockedReason({
      action: isEdit ? 'save' : 'create',
      hasModel: Boolean(selectedModel),
      hasName: Boolean(state.name.trim()),
    })
  const isDirty = isEdit ? differs(state, initialState ?? {}) : true
  const canSave = blocker === null && !isSaving && isDirty
  const modelOptionsError = modelOptionsQuery.error instanceof Error
    ? modelOptionsQuery.error.message
    : modelOptionsQuery.isError ? 'AI models could not be loaded.' : undefined

  const onModelSelect = useCallback((option: AgentModelOption) => {
    setModelSelection(option)
    setLocalBindingId(null)
  }, [setModelSelection])

  /** Saves the form; resolves to the stored agent, or null when nothing was saved. */
  const save = async (): Promise<AgentRecord | null> => {
    if (!state.name.trim() || !selectedModel) return null
    setSaveError(null)
    // Every field blank sends an explicit `null`, which clears stored limits.
    const runLimits = buildRunLimits(state.runLimits)
    try {
      if (agent) {
        const saved = await updateAgent.mutateAsync({
          agentId: agent.id,
          effort: state.effort,
          name: state.name.trim(),
          role: state.role.trim() || 'assistant',
          runLimits,
          // Explicit `null`: an emptied field is a decision, and `undefined`
          // would carry the stored value forward instead.
          speakingStyle: state.speakingStyle.trim() || null,
          voiceName: state.voiceName || null,
          systemPrompt: state.systemPrompt,
          todosEnabled: state.todosEnabled,
          ...(localSelection
            ? { localInferenceBindingId: localBindingId ?? undefined }
            : { model: state.model || undefined, provider: state.provider || undefined }),
          // (provider, model) cannot say WHICH linked account a model belongs
          // to; `null` on a model-service model takes the agent off any plan.
          modelSubscriptionId: localSelection ? undefined : selectedModel.modelSubscriptionId ?? null,
        })
        // The values just sent are the stored agent now.
        markSaved(state)
        return saved
      }
      const toolPolicy = buildToolPolicy(toolCatalog.options, state.tools)
      const created = await createAgent.mutateAsync({
        avatarAttachmentId,
        effort: state.effort,
        model: state.model || undefined,
        modelSubscriptionId: selectedModel.modelSubscriptionId ?? null,
        name: state.name.trim(),
        provider: state.provider || undefined,
        role: state.role.trim() || 'assistant',
        runLimits: runLimits ?? undefined,
        speakingStyle: state.speakingStyle.trim() || null,
        systemPrompt: state.systemPrompt.trim() || undefined,
        todosEnabled: state.todosEnabled,
        toolPolicy: Object.keys(toolPolicy).length > 0 ? toolPolicy : undefined,
        visibility: state.visibility,
        voiceName: state.voiceName || null,
      })
      // The next New agent starts blank rather than holding this one.
      clearDraft()
      return created
    } catch (error) {
      setSaveError(formErrorMessage(error, isEdit ? 'The changes could not be saved.' : 'The agent could not be created.'))
      return null
    }
  }

  return {
    actions,
    avatarAttachmentId,
    blocker,
    canSave,
    isDirty,
    isEdit,
    isSaving,
    localBindingId,
    modelOptions,
    modelOptionsError,
    modelsLoading: modelOptionsQuery.isLoading,
    onModelSelect,
    save,
    saveError,
    selectedModel: selectedModel ?? null,
    setAvatarAttachmentId,
    setLocalBindingId,
    state,
    toolCatalog,
  }
}

export type AgentConfigForm = ReturnType<typeof useAgentConfigForm>
