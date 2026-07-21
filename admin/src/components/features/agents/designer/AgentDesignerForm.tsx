import type { DesignerToolGroup } from '../../../../facades/designer/tool-catalog'
import { Link } from 'react-router-dom'
import type {
  AgentDesignerActions,
  AgentEffortValue,
  AgentFormState,
} from './useAgentDesigner'
import { ToolPicker } from './ToolPicker'

type AgentDesignerFormProps = {
  actions: AgentDesignerActions
  canManageExplicitTools: boolean
  parentAgentName?: string
  state: AgentFormState
  toolGroups: DesignerToolGroup[]
  toolsLoading: boolean
}

const PROVIDERS = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'MiniMax', value: 'minimax' },
  { label: 'Kimi (for coding)', value: 'kimi' },
  { label: 'Ollama', value: 'ollama' },
  { label: 'Custom', value: 'custom' },
]

type ModelGroup = { label: string; models: { label: string; value: string }[] }

const OPENAI_MODEL_GROUPS: ModelGroup[] = [
  {
    label: 'GPT-5 Series',
    models: [
      { value: 'gpt-5', label: 'gpt-5' },
      { value: 'gpt-5-mini', label: 'gpt-5-mini' },
      { value: 'gpt-5-nano', label: 'gpt-5-nano' },
    ],
  },
]

const ANTHROPIC_MODEL_GROUPS: ModelGroup[] = [
  {
    label: 'Claude 4',
    models: [
      { value: 'claude-opus-4-6', label: 'claude-opus-4-6' },
      { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
    ],
  },
  {
    label: 'Claude 3.5 / 3.7',
    models: [
      { value: 'claude-3-7-sonnet-20250219', label: 'claude-3-7-sonnet' },
      { value: 'claude-3-5-sonnet-20241022', label: 'claude-3-5-sonnet' },
      { value: 'claude-3-5-haiku-20241022', label: 'claude-3-5-haiku' },
    ],
  },
]

const fieldLabelClass = [
  'text-xs font-semibold uppercase',
  'tracking-[0.16em] text-[color:var(--tx3)]',
].join(' ')

const EFFORTS: { hint: string; label: string; value: string }[] = [
  { value: 'low', label: 'Low', hint: 'quick, cheap responses' },
  { value: 'medium', label: 'Medium', hint: 'balanced — default' },
  { value: 'high', label: 'High', hint: 'thorough multi-step work' },
  {
    value: 'xhigh',
    label: 'Ultra',
    hint: 'maximum effort, effectively unlimited token usage — governed only by team/org budgets',
  },
]

export const AgentDesignerForm = ({
  actions,
  canManageExplicitTools,
  parentAgentName,
  state,
  toolGroups,
  toolsLoading,
}: AgentDesignerFormProps) => {
  const isStreaming = (field: string) => state.streamingField === field

  return (
    <div className="grid gap-5">
      {/* Parent agent (read-only, shown only when creating a child) */}
      {parentAgentName !== undefined && (
        <div className="grid gap-1.5">
          <div className={fieldLabelClass}>Parent Agent</div>
          <div className="admin-input cursor-default opacity-60">{parentAgentName}</div>
        </div>
      )}

      {/* Name */}
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="agent-name">
          Name
        </label>
        <input
          autoComplete="off"
          className={[
            'admin-input',
            isStreaming('name') ? 'border-[var(--accent)] shadow-[0_0_0_1px_var(--accent-soft)]' : '',
          ].join(' ')}
          id="agent-name"
          onChange={(e) => actions.setName(e.target.value)}
          placeholder="e.g. Code Reviewer"
          value={state.name}
        />
      </div>

      {/* Role */}
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="agent-role">
          Role
        </label>
        <input
          autoComplete="off"
          className={[
            'admin-input',
            isStreaming('role') ? 'border-[var(--accent)] shadow-[0_0_0_1px_var(--accent-soft)]' : '',
          ].join(' ')}
          id="agent-role"
          onChange={(e) => actions.setRole(e.target.value)}
          placeholder="e.g. assistant, reviewer, analyst"
          value={state.role}
        />
      </div>

      {/* Provider & Model */}
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <label className={fieldLabelClass} htmlFor="agent-provider">
            Provider
          </label>
          <select
            className="admin-input"
            id="agent-provider"
            onChange={(e) => actions.setProvider(e.target.value)}
            value={state.provider}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <label className={fieldLabelClass} htmlFor="agent-model">
            Model
          </label>
          {state.provider === 'openai' || state.provider === 'anthropic' ? (
            <select
              className={[
                'admin-input',
                isStreaming('model')
                  ? 'border-[var(--accent)] shadow-[0_0_0_1px_var(--accent-soft)]'
                  : '',
              ].join(' ')}
              id="agent-model"
              onChange={(e) => actions.setModel(e.target.value)}
              value={state.model}
            >
              {(state.provider === 'openai' ? OPENAI_MODEL_GROUPS : ANTHROPIC_MODEL_GROUPS).map(
                (group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                ),
              )}
            </select>
          ) : (
            <input
              autoComplete="off"
              className={[
                'admin-input',
                isStreaming('model')
                  ? 'border-[var(--accent)] shadow-[0_0_0_1px_var(--accent-soft)]'
                  : '',
              ].join(' ')}
              id="agent-model"
              onChange={(e) => actions.setModel(e.target.value)}
              placeholder="e.g. llama3.2"
              value={state.model}
            />
          )}
        </div>
      </div>

      {/* Effort */}
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="agent-effort">
          Effort
        </label>
        <select
          className="admin-input"
          id="agent-effort"
          onChange={(e) => actions.setEffort(e.target.value as AgentEffortValue)}
          value={state.effort}
        >
          {EFFORTS.map((e) => (
            <option key={e.value} value={e.value}>
              {`${e.label} — ${e.hint}`}
            </option>
          ))}
        </select>
      </div>

      {/* System prompt */}
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="agent-system-prompt">
          System prompt
        </label>
        <textarea
          autoComplete="off"
          className={[
            'admin-input resize-none font-mono text-xs leading-relaxed',
            isStreaming('systemPrompt')
              ? 'border-[var(--accent)] shadow-[0_0_0_1px_var(--accent-soft)]'
              : '',
          ].join(' ')}
          id="agent-system-prompt"
          onChange={(e) => actions.setSystemPrompt(e.target.value)}
          placeholder="Instructions for the agent..."
          rows={12}
          value={state.systemPrompt}
        />
      </div>

      {/* Tools */}
      <div className="grid gap-1.5">
        <div className={fieldLabelClass}>Tools</div>
        <p className="text-xs text-[color:var(--tx3)]">
          Built-in tools are on by default; connector (MCP) tools must be
          switched on per agent.
        </p>
        <p className="text-xs text-[color:var(--tx3)]">
          Explicit-grant tools are protected from Agent Designer edits.{' '}
          {canManageExplicitTools ? (
            <>
              Manage them in <Link className="underline" to="/agents/tools">Tools</Link>
              {' '}or <Link className="underline" to="/integrations">Integrations</Link>.
            </>
          ) : (
            'An organization owner manages them in Tools or Integrations.'
          )}
        </p>
        <ToolPicker
          groups={toolGroups}
          isLoading={toolsLoading}
          onToggle={actions.toggleTool}
          toolState={state.tools}
        />
      </div>
    </div>
  )
}
