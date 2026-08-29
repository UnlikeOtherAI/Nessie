import type { DesignerToolGroup } from '../../../../facades/designer/tool-catalog'
import type { AgentModelOption } from '../../../../lib/api-client'
import { Link } from 'react-router-dom'
import type {
  AgentDesignerActions,
  AgentEffortValue,
  AgentFormState,
} from './useAgentDesigner'
import { ModelCombobox } from './ModelCombobox'
import { RunLimitsFieldset } from './RunLimitsFieldset'
import { ToolPicker } from './ToolPicker'

type AgentDesignerFormProps = {
  actions: AgentDesignerActions
  canManageExplicitTools: boolean
  modelOptions: AgentModelOption[]
  modelOptionsError?: string
  modelsLoading: boolean
  parentAgentName?: string
  // Tools live on the agent detail page's Tools tab for an existing agent; the
  // designer only shows the picker while creating one (no Tools tab yet).
  showTools?: boolean
  state: AgentFormState
  toolGroups: DesignerToolGroup[]
  toolsLoading: boolean
}

const fieldLabelClass = [
  'text-xs font-semibold uppercase',
  'tracking-[0.16em] text-[color:var(--tx3)]',
].join(' ')

// Reasoning effort maps only to the provider's `reasoning_effort` — how hard
// the model thinks per turn. Spend ceilings live in the Run limits fieldset.
const EFFORTS: { hint: string; label: string; value: string }[] = [
  { value: 'low', label: 'Low', hint: 'quick, shallow reasoning' },
  { value: 'medium', label: 'Medium', hint: 'balanced — default' },
  { value: 'high', label: 'High', hint: 'thorough multi-step reasoning' },
  { value: 'xhigh', label: 'Ultra', hint: 'deepest reasoning the model offers' },
]

export const AgentDesignerForm = ({
  actions,
  canManageExplicitTools,
  modelOptions,
  modelOptionsError,
  modelsLoading,
  parentAgentName,
  showTools = true,
  state,
  toolGroups,
  toolsLoading,
}: AgentDesignerFormProps) => {
  const isStreaming = (field: string) => state.streamingField === field
  const selectedModel = modelOptions.find(
    (option) => option.model === state.model && option.provider === state.provider,
  )
  const hasUnavailableSelection = Boolean(state.model && state.provider && !selectedModel)

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
        <ModelCombobox
          disabled={modelsLoading || modelOptions.length === 0}
          emptyLabel="No models match that search"
          highlighted={isStreaming('model')}
          id="agent-model"
          onSelect={actions.setModelSelection}
          options={modelOptions}
          placeholder={modelsLoading ? 'Loading Ledger models…' : 'Search models…'}
          value={selectedModel ?? null}
        />
        {hasUnavailableSelection ? (
          <p className="text-xs text-[color:var(--tx3)]">
            Current model ({state.model}) is no longer available — select a replacement.
          </p>
        ) : null}
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

      {/* Reasoning effort */}
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="agent-effort">
          Reasoning effort
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
        <p className="text-xs text-[color:var(--tx3)]">
          How hard the model thinks — does not limit what a run may spend.
        </p>
      </div>

      {/* Run limits */}
      <RunLimitsFieldset
        labelClassName={fieldLabelClass}
        onChange={actions.setRunLimit}
        value={state.runLimits}
      />

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

      {/* Tools — only while creating. An existing agent's tools are managed on
          the detail page's Tools tab. */}
      {showTools ? (
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
          <p className="text-xs text-[color:var(--tx3)]">
            Executor operations require a separate exact executor-agent-operation grant.{' '}
            <Link className="underline" to="/agents/executors">Manage executors and access</Link>.
          </p>
          <ToolPicker
            groups={toolGroups}
            isLoading={toolsLoading}
            onToggle={actions.toggleTool}
            toolState={state.tools}
          />
        </div>
      ) : null}
    </div>
  )
}
