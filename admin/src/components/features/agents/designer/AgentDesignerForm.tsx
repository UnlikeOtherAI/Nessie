import type { DesignerToolGroup } from '../../../../facades/designer/tool-catalog'
import type { AgentModelOption } from '../../../../lib/api-client'
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
  modelOptions: AgentModelOption[]
  modelOptionsError?: string
  modelsLoading: boolean
  parentAgentName?: string
  state: AgentFormState
  toolGroups: DesignerToolGroup[]
  toolsLoading: boolean
}

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
  modelOptions,
  modelOptionsError,
  modelsLoading,
  parentAgentName,
  state,
  toolGroups,
  toolsLoading,
}: AgentDesignerFormProps) => {
  const isStreaming = (field: string) => state.streamingField === field
  const modelOptionKey = (option: Pick<AgentModelOption, 'model' | 'provider'>) =>
    JSON.stringify([option.provider, option.model])
  const selectedModel = modelOptions.find(
    (option) => option.model === state.model && option.provider === state.provider,
  )
  const hasUnavailableSelection = Boolean(state.model && state.provider && !selectedModel)
  const modelsByProvider = modelOptions.reduce<Map<string, AgentModelOption[]>>(
    (groups, option) => {
      const current = groups.get(option.providerDisplayName) ?? []
      current.push(option)
      groups.set(option.providerDisplayName, current)
      return groups
    },
    new Map(),
  )

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

      {/* Ledger-authorized model */}
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="agent-model">
          Model
        </label>
        <select
          className={[
            'admin-input',
            isStreaming('model')
              ? 'border-[var(--accent)] shadow-[0_0_0_1px_var(--accent-soft)]'
              : '',
          ].join(' ')}
          disabled={modelsLoading || modelOptions.length === 0}
          id="agent-model"
          onChange={(e) => {
            const option = modelOptions.find(
              (candidate) => modelOptionKey(candidate) === e.target.value,
            )
            if (option) actions.setModelSelection(option)
          }}
          value={selectedModel ? modelOptionKey(selectedModel) : ''}
        >
          <option value="">
            {modelsLoading ? 'Loading Ledger models…' : 'Select a model'}
          </option>
          {hasUnavailableSelection ? (
            <option disabled value="">
              Current model is no longer available — select a replacement
            </option>
          ) : null}
          {[...modelsByProvider.entries()].map(([provider, models]) => (
            <optgroup key={provider} label={provider}>
              {models.map((option) => (
                <option key={modelOptionKey(option)} value={modelOptionKey(option)}>
                  {option.displayName === option.model
                    ? option.model
                    : `${option.displayName} (${option.model})`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {selectedModel ? (
          <p className="text-xs text-[color:var(--tx3)]">
            {selectedModel.description
              ?? `Runs through Ledger’s ${selectedModel.providerDisplayName} service.`}
          </p>
        ) : null}
        {modelOptionsError ? (
          <p className="text-xs text-[color:var(--danger)]" role="alert">
            {modelOptionsError}
          </p>
        ) : null}
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
            'admin-input admin-input-compact admin-input-mono resize-none',
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
              {' '}or{' '}
              <Link className="underline" to="/settings/integrations">
                Integrations
              </Link>.
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
