import { useCallback, useReducer } from 'react'
import type { AgentModelOption } from '../../../../lib/api-client'
import { findModelOption } from './model-options'
import {
  emptyRunLimitsForm,
  type RunLimitsField,
  type RunLimitsFormState,
} from './run-limits'

export type AgentEffortValue = 'low' | 'medium' | 'high' | 'xhigh'

export type AgentFormState = {
  effort: AgentEffortValue
  model: string
  name: string
  provider: string
  role: string
  // Optional explicit per-run caps; blank fields mean "governed by the
  // deployment backstop". Separate from `effort`, which is reasoning depth only.
  runLimits: RunLimitsFormState
  streamingField: string | null
  systemPrompt: string
  tools: Record<string, boolean>
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
  | { enabled: boolean; toolId: string; type: 'toggle_tool' }

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
  streamingField: null,
  systemPrompt: '',
  tools: {},
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
    case 'toggle_tool':
      return { ...state, tools: { ...state.tools, [action.toolId]: action.enabled } }
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
  setSystemPrompt: (prompt: string) => void
  toggleTool: (toolId: string, enabled: boolean) => void
}

export const useAgentDesigner = (
  initialState?: Partial<AgentFormState>,
  // The catalogue the Design Assistant was shown, so a model it names can be
  // resolved back to the entry the picker renders.
  modelOptions: AgentModelOption[] = [],
) => {
  const [state, dispatch] = useReducer(reducer, {
    ...DEFAULT_STATE,
    ...initialState,
  })

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
    setSystemPrompt,
    toggleTool,
  }

  return { actions, state }
}
