import type { ReactNode } from 'react'
import type { DesignerToolCatalogQuery, DesignerToolGroup } from '../../../../facades/designer/tool-catalog'
import type { AgentModelOption } from '../../../../lib/api-client'
import { Link } from 'react-router-dom'
import type {
  AgentDesignerActions,
  AgentEffortValue,
  AgentFormState,
} from './useAgentDesigner'
import { AgentSpeechFieldset } from './AgentSpeechFieldset'
import { ModelCombobox } from './ModelCombobox'
import { RunLimitsFieldset } from './RunLimitsFieldset'
import { STREAMING_HIGHLIGHT_CLASS } from './streaming-highlight'
import { ToolPicker } from './ToolPicker'
import { Switch } from '../../../primitives/Switch'
import { FieldLabel } from '../../../primitives/FieldLabel'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { Card } from '../../../shared/Card'
import { FormField } from '../../../shared/FormField'
import { Input, Select, Textarea } from '../../../shared/FormControls'

type AgentDesignerFormProps = {
  actions: AgentDesignerActions
  canManageExplicitTools: boolean
  canManageTodos: boolean
  /**
   * A lead-in note rendered above the first field. It exists so a form nobody
   * may save can still say why, in the ordinary layout, rather than being
   * replaced by a card that explains it.
   */
  leadIn?: ReactNode
  modelOptions: AgentModelOption[]
  modelOptionsError?: string
  modelsLoading: boolean
  parentAgentName?: string
  /**
   * Render every control disabled and offer no way to change anything. A reader
   * who may not edit this agent sees the *same* form — same sections, same
   * order, same controls in the same places — simply not theirs to touch. It is
   * one prop rather than a second render path precisely so the two can never
   * drift into describing different agents (Rule zero #4).
   */
  readOnly?: boolean
  // Tools live on the agent detail page's Tools tab for an existing agent; the
  // designer only shows the picker while creating one (no Tools tab yet).
  showTools?: boolean
  state: AgentFormState
  toolGroups: DesignerToolGroup[]
  toolsQuery: DesignerToolCatalogQuery
  visibilityReadOnly?: boolean
}

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
  canManageTodos,
  leadIn,
  modelOptions,
  modelOptionsError,
  modelsLoading,
  parentAgentName,
  readOnly = false,
  showTools = true,
  state,
  toolGroups,
  toolsQuery,
  visibilityReadOnly = false,
}: AgentDesignerFormProps) => {
  const isStreaming = (field: string) => state.streamingField === field
  const highlightClass = (field: string) => (isStreaming(field) ? STREAMING_HIGHLIGHT_CLASS : '')
  const selectedModel = modelOptions.find(
    (option) => option.model === state.model && option.provider === state.provider,
  )
  const hasUnavailableSelection = Boolean(state.model && state.provider && !selectedModel)

  return (
    <div className="grid gap-5">
      {leadIn}

      {/* Parent agent (read-only, shown only when creating a child) */}
      {parentAgentName !== undefined && (
        <FormField label="Parent Agent">
          <Input className="cursor-default opacity-60" readOnly tabIndex={-1} value={parentAgentName} />
        </FormField>
      )}

      {/* Name and Role pin their ids (`agent-name`, `agent-role`): the Design
          Assistant's reveal-and-focus animation
          (`designer/reveal-control.ts`) resolves them with
          `document.getElementById`, so a generated id would break it. */}
      <FormField id="agent-name" label="Name">
        <Input
          autoComplete="off"
          className={highlightClass('name')}
          disabled={readOnly}
          onChange={(e) => actions.setName(e.target.value)}
          placeholder="e.g. Code Reviewer"
          value={state.name}
        />
      </FormField>

      <FormField id="agent-role" label="Role">
        <Input
          autoComplete="off"
          className={highlightClass('role')}
          disabled={readOnly}
          onChange={(e) => actions.setRole(e.target.value)}
          placeholder="e.g. assistant, reviewer, analyst"
          value={state.role}
        />
      </FormField>

      <Card className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <SectionLabel size="sm">Visibility</SectionLabel>
          {visibilityReadOnly ? (
            <>
              <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
                {state.visibility === 'private' ? 'Only visible to you' : 'Team-visible'}
              </p>
              <p className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
                Visibility is set when an agent is created and cannot be changed.
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
                {state.visibility === 'private'
                  ? 'Private — only you can see it.'
                  : 'Team-visible — people in this team can find it.'}
              </p>
              <p className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
                A private agent cannot be added to any project, channel, or conversation, and only
                you can see it.
              </p>
            </>
          )}
        </div>
        {!visibilityReadOnly ? (
          <Switch
            checked={state.visibility === 'private'}
            disabled={readOnly}
            label="Only visible to me"
            onChange={(checked) => actions.setVisibility(checked ? 'private' : 'team')}
          />
        ) : null}
      </Card>

      {/* Model stays outside `FormField`, and the reason is not its pinned id
          — `FormField` takes one now. `ModelCombobox` is a bespoke combobox
          with its own listbox and keyboard handling, and it does not consume
          the field context, so wrapping it would render a label and an error
          region that were not actually wired to the control it describes:
          the appearance of the contract without the contract. */}
      <div className="grid gap-1.5">
        <FieldLabel htmlFor="agent-model">Model</FieldLabel>
        <ModelCombobox
          // Deliberately NOT disabled on an empty list: the list itself now
          // carries the "Link a personal subscription…" doorway, and a
          // deployment whose Ledger catalogue is empty or unreachable is
          // exactly when a person most needs to reach it.
          disabled={modelsLoading || readOnly}
          emptyLabel="No models match that search"
          highlighted={isStreaming('model')}
          id="agent-model"
          onLinkSubscription={() => {
            window.open('/settings/connections', '_blank', 'noopener,noreferrer')
          }}
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
          <p className="text-xs text-[color:var(--danger-text)]" role="alert">
            {modelOptionsError}
          </p>
        ) : null}
      </div>

      {/* Reasoning effort */}
      <FormField help="How hard the model thinks — does not limit what a run may spend." label="Reasoning effort">
        <Select
          disabled={readOnly}
          onChange={(e) => actions.setEffort(e.target.value as AgentEffortValue)}
          value={state.effort}
        >
          {EFFORTS.map((e) => (
            <option key={e.value} value={e.value}>
              {`${e.label} — ${e.hint}`}
            </option>
          ))}
        </Select>
      </FormField>

      {/* Run limits */}
      <RunLimitsFieldset
        disabled={readOnly}
        onChange={actions.setRunLimit}
        value={state.runLimits}
      />

      {/* Voice and manner — how this agent sounds on a call, and how it talks
          everywhere. */}
      <AgentSpeechFieldset
        disabled={readOnly}
        onSpeakingStyleChange={actions.setSpeakingStyle}
        onVoiceNameChange={actions.setVoiceName}
        speakingStyle={state.speakingStyle}
        voiceName={state.voiceName}
      />

      <Card className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <SectionLabel size="sm">To-dos</SectionLabel>
          <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
            Give this agent reusable checklists it can work through.
          </p>
          <p className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
            Step instructions are visible to everyone who can see this agent. Do not put secrets in them.
          </p>
          {!canManageTodos && !readOnly ? (
            <p className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
              Only organization owners can enable or disable to-dos.
            </p>
          ) : null}
        </div>
        <Switch
          checked={state.todosEnabled}
          disabled={!canManageTodos || readOnly}
          label="Enable to-dos for this agent"
          onChange={actions.setTodosEnabled}
        />
      </Card>

      <FormField id="agent-system-prompt" label="System prompt">
        <Textarea
          autoComplete="off"
          className={['resize-none', highlightClass('systemPrompt')].filter(Boolean).join(' ')}
          disabled={readOnly}
          mono
          onChange={(e) => actions.setSystemPrompt(e.target.value)}
          placeholder="Instructions for the agent..."
          rows={12}
          size="compact"
          value={state.systemPrompt}
        />
      </FormField>

      {/* Tools — only while creating. An existing agent's tools are managed on
          the detail page's Tools tab. */}
      {showTools ? (
        <div className="grid gap-1.5">
          <SectionLabel>Tools</SectionLabel>
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
            onToggle={actions.toggleTool}
            query={toolsQuery}
            readOnly={readOnly}
            toolState={state.tools}
          />
        </div>
      ) : null}
    </div>
  )
}
