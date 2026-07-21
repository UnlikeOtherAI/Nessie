import { useCallback, useReducer } from 'react'

export type AgentEffortValue = 'low' | 'medium' | 'high' | 'xhigh'

export type AgentFormState = {
  effort: AgentEffortValue
  model: string
  name: string
  provider: string
  role: string
  streamingField: string | null
  systemPrompt: string
  tools: Record<string, boolean>
}

export type AgentDesignerAction =
  | { chunk: string; type: 'append_system_prompt' }
  | { field: string; type: 'clear_streaming' }
  | { field: string; type: 'set_streaming' }
  | { effort: AgentEffortValue; type: 'set_effort' }
  | { model: string; type: 'set_model' }
  | { name: string; type: 'set_name' }
  | { prompt: string; type: 'set_system_prompt' }
  | { provider: string; type: 'set_provider' }
  | { role: string; type: 'set_role' }
  | { enabled: boolean; toolId: string; type: 'toggle_tool' }

// `tools` is a sparse overlay over the org tool catalog: unset keys fall back
// to the tool kind's default (builtin on, connector off) — the same semantics
// the worker applies to `Agent.toolPolicy`.
const DEFAULT_STATE: AgentFormState = {
  effort: 'medium',
  model: 'gpt-5',
  name: '',
  provider: 'openai',
  role: 'assistant',
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
    case 'set_provider':
      return { ...state, provider: action.provider }
    case 'set_model':
      return { ...state, model: action.model }
    case 'set_effort':
      return { ...state, effort: action.effort }
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
  setModel: (model: string) => void
  setName: (name: string) => void
  setProvider: (provider: string) => void
  setRole: (role: string) => void
  setSystemPrompt: (prompt: string) => void
  toggleTool: (toolId: string, enabled: boolean) => void
}

export const useAgentDesigner = (initialState?: Partial<AgentFormState>) => {
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
  const setProvider = useCallback(
    (provider: string) => dispatch({ type: 'set_provider', provider }),
    [],
  )
  const setModel = useCallback((model: string) => dispatch({ type: 'set_model', model }), [])
  const setEffort = useCallback(
    (effort: AgentEffortValue) => dispatch({ type: 'set_effort', effort }),
    [],
  )
  const toggleTool = useCallback(
    (toolId: string, enabled: boolean) => dispatch({ type: 'toggle_tool', toolId, enabled }),
    [],
  )

  const applyToolCall = useCallback((name: string, args: Record<string, unknown>) => {
    switch (name) {
      case 'set_name':
        dispatch({ type: 'set_name', name: String(args.name ?? '') })
        break
      case 'set_role':
        dispatch({ type: 'set_role', role: String(args.role ?? '') })
        break
      case 'set_system_prompt':
        dispatch({ type: 'set_system_prompt', prompt: String(args.content ?? '') })
        break
      case 'set_provider':
        dispatch({ type: 'set_provider', provider: String(args.provider ?? '') })
        break
      case 'set_model':
        dispatch({ type: 'set_model', model: String(args.model ?? '') })
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
  }, [])

  const actions: AgentDesignerActions = {
    applyToolCall,
    dispatch,
    setEffort,
    setModel,
    setName,
    setProvider,
    setRole,
    setSystemPrompt,
    toggleTool,
  }

  return { actions, state }
}
