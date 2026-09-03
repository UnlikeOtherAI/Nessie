import { useCallback, useEffect, useReducer, useRef } from 'react'
import { draftKey, useDraft } from '../../../../navigation/useDraft'
import type { AgentModelOption } from '../../../../lib/api-client'
import { findModelOption } from './model-options'
import {
  emptyRunLimitsForm,
  type RunLimitsField,
  type RunLimitsFormState,
} from './run-limits'

export type AgentEffortValue = 'low' | 'medium' | 'high' | 'xhigh'
export type AgentVisibilityValue = 'private' | 'team'

export type AgentFormState = {
  effort: AgentEffortValue
  model: string
  name: string
  provider: string
  role: string
  // Optional explicit per-run caps; blank fields mean "governed by the
  // deployment backstop". Separate from `effort`, which is reasoning depth only.
  runLimits: RunLimitsFormState
  /**
   * How this agent talks to people. The stored value is the *text*, never the
   * preset that seeded it — see `AGENT_SPEAKING_STYLE_PRESETS`. Empty = none.
   */
  speakingStyle: string
  streamingField: string | null
  systemPrompt: string
  todosEnabled: boolean
  tools: Record<string, boolean>
  visibility: AgentVisibilityValue
  /** One of `GEMINI_LIVE_VOICES`, or '' for the deployment default. */
  voiceName: string
}

export type AgentDesignerAction =
  | { chunk: string; type: 'append_system_prompt' }
  | { field: string; type: 'clear_streaming' }
  | { field: string; type: 'set_streaming' }
  | { effort: AgentEffortValue; type: 'set_effort' }
  // Model and provider are one decision: the form resolves its selection by
  // matching both, so a half-applied pair reads as no model at all.
  | { option: AgentModelOption; type: 'set_model_selection' }
  | { name: string; type: 'set_name' }
  | { prompt: string; type: 'set_system_prompt' }
  | { role: string; type: 'set_role' }
  | { field: RunLimitsField; type: 'set_run_limit'; value: string }
  | { enabled: boolean; type: 'set_todos_enabled' }
  | { style: string; type: 'set_speaking_style' }
  | { type: 'set_voice_name'; voiceName: string }
  | { enabled: boolean; toolId: string; type: 'toggle_tool' }
  | { visibility: AgentVisibilityValue; type: 'set_visibility' }
  // A stored draft coming back on mount. The reducer owns the state, so a
  // restore is an action rather than a second writer.
  | { state: AgentFormState; type: 'restore' }

// `tools` is a sparse overlay over the org tool catalog: unset keys fall back
// to the tool kind's default (builtin on, connector off) — the same semantics
// the worker applies to `Agent.toolPolicy`.
const DEFAULT_STATE: AgentFormState = {
  effort: 'medium',
  model: '',
  name: '',
  provider: '',
  role: 'assistant',
  runLimits: emptyRunLimitsForm,
  speakingStyle: '',
  streamingField: null,
  systemPrompt: '',
  todosEnabled: false,
  tools: {},
  visibility: 'team',
  voiceName: '',
}

const reducer = (state: AgentFormState, action: AgentDesignerAction): AgentFormState => {
  switch (action.type) {
    case 'set_name':
      return { ...state, name: action.name }
    case 'set_role':
      return { ...state, role: action.role }
    case 'set_system_prompt':
      return { ...state, systemPrompt: action.prompt }
    case 'append_system_prompt':
      return { ...state, systemPrompt: state.systemPrompt + action.chunk }
    case 'set_model_selection':
      return {
        ...state,
        model: action.option.model,
        provider: action.option.provider,
      }
    case 'set_effort':
      return { ...state, effort: action.effort }
    case 'set_run_limit':
      return {
        ...state,
        runLimits: { ...state.runLimits, [action.field]: action.value },
      }
    case 'set_todos_enabled':
      return { ...state, todosEnabled: action.enabled }
    case 'set_speaking_style':
      return { ...state, speakingStyle: action.style }
    case 'set_voice_name':
      return { ...state, voiceName: action.voiceName }
    case 'toggle_tool':
      return { ...state, tools: { ...state.tools, [action.toolId]: action.enabled } }
    case 'set_visibility':
      return { ...state, visibility: action.visibility }
    case 'restore':
      return { ...action.state, streamingField: null }
    case 'set_streaming':
      return { ...state, streamingField: action.field }
    case 'clear_streaming':
      return { ...state, streamingField: null }
    default:
      return state
  }
}

export type AgentDesignerActions = {
  applyToolCall: (name: string, args: Record<string, unknown>) => void
  dispatch: React.Dispatch<AgentDesignerAction>
  setEffort: (effort: AgentEffortValue) => void
  setModelSelection: (option: AgentModelOption) => void
  setName: (name: string) => void
  setRole: (role: string) => void
  setRunLimit: (field: RunLimitsField, value: string) => void
  setSpeakingStyle: (style: string) => void
  setSystemPrompt: (prompt: string) => void
  setTodosEnabled: (enabled: boolean) => void
  setVoiceName: (voiceName: string) => void
  toggleTool: (toolId: string, enabled: boolean) => void
  setVisibility: (visibility: AgentVisibilityValue) => void
}

// `streamingField` is a live indicator of the Design Assistant writing into a
// field right now; it belongs to the mount, never to the stored draft.
const sameAsBaseline = (value: AgentFormState, baseline: AgentFormState): boolean =>
  JSON.stringify({ ...value, streamingField: null })
  === JSON.stringify({ ...baseline, streamingField: null })

export const useAgentDesigner = (
  initialState?: Partial<AgentFormState>,
  // The catalogue the Design Assistant was shown, so a model it names can be
  // resolved back to the entry the picker renders.
  modelOptions: AgentModelOption[] = [],
  // The agent being edited, or undefined for a new one — the draft's entity.
  agentId?: string,
) => {
  const [state, dispatch] = useReducer(reducer, {
    ...DEFAULT_STATE,
    ...initialState,
  })

  // Drafts (docs/navigation/overview.md → "Drafts"): the form is buffered under
  // `draft:agent-designer:<agentId | new>`, so leaving the designer — Back, a
  // reload, a tab close — no longer discards a half-written system prompt.
  // Local only: a debounced PUT would publish an agent's behaviour to every
  // channel it is bound to on every keystroke, and creating one needs a model
  // the form may not have yet, so Save stays the deliberate act.
  const baseline: AgentFormState = { ...DEFAULT_STATE, ...initialState }
  const formDraft = useDraft<AgentFormState>(draftKey('agent-designer', agentId ?? 'new'), {
    initial: baseline,
    isEmpty: (value) => sameAsBaseline(value, baseline),
  })
  const { draft: draftState, revision: draftRevision, setDraft: setFormDraft } = formDraft

  // The reducer stays the single writer of form state, so the draft is written
  // from it rather than replacing it.
  const restoredRevisionRef = useRef<number | null>(null)
  useEffect(() => {
    if (restoredRevisionRef.current === draftRevision) return
    restoredRevisionRef.current = draftRevision
    if (draftRevision === 0) return
    dispatch({ state: draftState, type: 'restore' })
    // The draft's own replacements only; typing goes the other way.
  }, [draftRevision])

  // An untouched form is never mirrored: on mount the reducer still holds the
  // empty baseline until the restore above lands, and writing that baseline
  // first counts as "nothing to store" and deletes the draft the person came
  // back for. Decided by comparison, not by a first-run flag — StrictMode
  // re-runs effects with refs intact, and a flag armed on the first pass let
  // the second pass wipe the draft. Once the form has been edited (or a
  // stored draft restored), clearing it back to the baseline is a real
  // change and does delete the stored draft.
  const mirrorDirtyRef = useRef(false)
  useEffect(() => {
    const untouched = sameAsBaseline(state, baseline)
    if (untouched && !mirrorDirtyRef.current && draftRevision === 0) return
    mirrorDirtyRef.current = true
    setFormDraft(state)
    // `baseline` is rebuilt every render; its content is what matters.
  }, [draftRevision, setFormDraft, state])

  const setName = useCallback((name: string) => dispatch({ type: 'set_name', name }), [])
  const setRole = useCallback((role: string) => dispatch({ type: 'set_role', role }), [])
  const setSystemPrompt = useCallback(
    (prompt: string) => dispatch({ type: 'set_system_prompt', prompt }),
    [],
  )
  const setModelSelection = useCallback(
    (option: AgentModelOption) => dispatch({ option, type: 'set_model_selection' }),
    [],
  )
  const setEffort = useCallback(
    (effort: AgentEffortValue) => dispatch({ type: 'set_effort', effort }),
    [],
  )
  const setRunLimit = useCallback(
    (field: RunLimitsField, value: string) =>
      dispatch({ field, type: 'set_run_limit', value }),
    [],
  )
  const toggleTool = useCallback(
    (toolId: string, enabled: boolean) => dispatch({ type: 'toggle_tool', toolId, enabled }),
    [],
  )
  const setVisibility = useCallback(
    (visibility: AgentVisibilityValue) => dispatch({ type: 'set_visibility', visibility }),
    [],
  )
  const setTodosEnabled = useCallback(
    (enabled: boolean) => dispatch({ enabled, type: 'set_todos_enabled' }),
    [],
  )
  const setSpeakingStyle = useCallback(
    (style: string) => dispatch({ style, type: 'set_speaking_style' }),
    [],
  )
  const setVoiceName = useCallback(
    (voiceName: string) => dispatch({ type: 'set_voice_name', voiceName }),
    [],
  )

  const applyToolCall = useCallback((name: string, args: Record<string, unknown>) => {
    switch (name) {
      case 'set_model': {
        const option = findModelOption(
          modelOptions,
          String(args.model ?? ''),
          String(args.provider ?? ''),
        )
        // A pair outside the catalogue could never be saved, so the selection
        // already on the form — the preselected leader, or the user's own
        // choice — is the better answer than clearing it.
        if (option) dispatch({ option, type: 'set_model_selection' })
        break
      }
      case 'set_name':
        dispatch({ type: 'set_name', name: String(args.name ?? '') })
        break
      case 'set_role':
        dispatch({ type: 'set_role', role: String(args.role ?? '') })
        break
      case 'set_system_prompt':
        dispatch({ type: 'set_system_prompt', prompt: String(args.content ?? '') })
        break
      case 'toggle_tool':
        dispatch({
          type: 'toggle_tool',
          toolId: String(args.toolId ?? ''),
          enabled: Boolean(args.enabled),
        })
        break
      case 'batch_toggle_tools':
        if (Array.isArray(args.tools)) {
          for (const t of args.tools) {
            const tool = t as { enabled?: boolean; toolId?: string }
            if (tool.toolId !== undefined) {
              dispatch({
                type: 'toggle_tool',
                toolId: String(tool.toolId),
                enabled: Boolean(tool.enabled),
              })
            }
          }
        }
        break
    }
  }, [modelOptions])

  const actions: AgentDesignerActions = {
    applyToolCall,
    dispatch,
    setEffort,
    setModelSelection,
    setName,
    setRole,
    setRunLimit,
    setSpeakingStyle,
    setSystemPrompt,
    setVisibility,
    setTodosEnabled,
    setVoiceName,
    toggleTool,
  }

  return { actions, clearDraft: formDraft.clear, state }
}
