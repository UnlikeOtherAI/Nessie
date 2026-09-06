import type { Dispatch } from 'react'
import type { AgentModelOption } from '../../lib/api-client'
import type { RunLimitsField, RunLimitsFormState } from './run-limits'

/**
 * The Agent Designer form's contract.
 *
 * The shape of the form is the facade's, not the component's: the designer
 * facade's hooks take the state and the actions as parameters, and
 * `agent-designer-identity.ts` reads the same state. Declaring them here keeps
 * `facades/designer/*` from importing the hook that happens to produce them.
 */

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

export type AgentDesignerActions = {
  applyToolCall: (name: string, args: Record<string, unknown>) => void
  dispatch: Dispatch<AgentDesignerAction>
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

/** What the Design Assistant is told about the screen it is helping with. */
export type DesignerPageContext = {
  actions: string[]
  description: string
  title: string
}
