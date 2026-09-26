import type { AgentConfigForm } from '../../src/components/features/agents/page/useAgentConfigForm.js'
import { emptyRunLimitsForm } from '../../src/facades/designer/run-limits.js'
import type { AgentDesignerActions, AgentFormState } from '../../src/facades/designer/types.js'

/**
 * A stand-in for `useAgentConfigForm` in a server-rendered field test: the
 * real field components read only its state, actions and model facts, and a
 * test that only renders them has no reason to reach the API.
 */
const noop = () => undefined

export const designerActions: AgentDesignerActions = {
  applyToolCall: noop,
  dispatch: noop,
  setEffort: noop,
  setModelSelection: noop,
  setName: noop,
  setRole: noop,
  setRunLimit: noop,
  setSpeakingStyle: noop,
  setSystemPrompt: noop,
  setTodosEnabled: noop,
  setVisibility: noop,
  setVoiceName: noop,
  toggleTool: noop,
}

export const designerState = (overrides: Partial<AgentFormState> = {}): AgentFormState => ({
  effort: 'medium',
  localInferenceHostId: '',
  localManifestDigest: '',
  model: '',
  modelSubscriptionId: '',
  name: 'Checklist agent',
  provider: '',
  role: 'assistant',
  runLimits: emptyRunLimitsForm,
  speakingStyle: '',
  streamingField: null,
  systemPrompt: 'You check lists.',
  todosEnabled: false,
  tools: {},
  visibility: 'team',
  voiceName: '',
  ...overrides,
})

export const fakeAgentConfigForm = (
  overrides: { isEdit?: boolean; state?: Partial<AgentFormState> } = {},
): AgentConfigForm => ({
  actions: designerActions,
  avatarAttachmentId: undefined,
  blocker: null,
  canSave: false,
  isDirty: false,
  isEdit: overrides.isEdit ?? true,
  isSaving: false,
  localBindingId: null,
  modelOptions: [],
  modelOptionsError: undefined,
  modelsLoading: false,
  onModelSelect: noop,
  save: async () => null,
  saveError: null,
  selectedModel: null,
  setAvatarAttachmentId: noop,
  setLocalBindingId: noop,
  state: designerState(overrides.state),
  toolCatalog: { groups: [], isError: false, isLoading: false, options: [] },
} as unknown as AgentConfigForm)
