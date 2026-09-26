import type { AgentEffortValue } from '../../../../facades/designer/types'
import { Switch } from '../../../primitives/Switch'
import { FormField } from '../../../shared/FormField'
import { Input, Select, Textarea } from '../../../shared/FormControls'
import { AgentVisibilityPicker } from '../AgentVisibilityPicker'
import { AgentModelField } from '../designer/AgentModelField'
import { AgentMannerField, AgentVoiceField } from '../designer/AgentSpeechFieldset'
import { RunLimitsFieldset } from '../designer/RunLimitsFieldset'
import { STREAMING_HIGHLIGHT_CLASS } from '../designer/streaming-highlight'
import type { AgentConfigForm } from './useAgentConfigForm'

/**
 * The agent's configuration fields, in the groups the page's tabs hold them
 * in. Every group renders the same controls for every reader: a person who
 * may not change the agent sees them inert, through each group's own
 * `<fieldset disabled>`, never a second read-only rendering that could drift.
 *
 * Name, role, instructions and model keep their fixed ids (`agent-name`,
 * `agent-role`, `agent-system-prompt`, `agent-model`): the Design Assistant's
 * reveal (`designer/reveal-control.ts`) finds them with `getElementById`.
 */

type FieldsProps = {
  form: AgentConfigForm
  readOnly: boolean
}

const highlight = (form: AgentConfigForm, field: string): string =>
  form.state.streamingField === field ? STREAMING_HIGHLIGHT_CLASS : ''

export const AgentNameRoleFields = ({ form, readOnly }: FieldsProps) => (
  <fieldset className="grid gap-5 border-0 p-0" disabled={readOnly}>
    <FormField id="agent-name" label="Name">
      <Input
        autoComplete="off"
        className={highlight(form, 'name')}
        onChange={(event) => form.actions.setName(event.target.value)}
        placeholder="e.g. Code Reviewer"
        value={form.state.name}
      />
    </FormField>
    <FormField id="agent-role" label="Role">
      <Input
        autoComplete="off"
        className={highlight(form, 'role')}
        onChange={(event) => form.actions.setRole(event.target.value)}
        placeholder="e.g. assistant, reviewer, analyst"
        value={form.state.role}
      />
    </FormField>
  </fieldset>
)

/** Chosen once, when the agent is created; an existing agent shows it fixed. */
export const AgentVisibilityField = ({ form, readOnly }: FieldsProps) => (
  <AgentVisibilityPicker
    onChange={form.actions.setVisibility}
    readOnly={readOnly || form.isEdit}
    value={form.state.visibility}
  />
)

export const AgentInstructionsField = ({ form, readOnly }: FieldsProps) => (
  <fieldset className="grid gap-1.5 border-0 p-0" disabled={readOnly}>
    <FormField
      help="What this agent does and how it should work. Saved as its AGENTS.md."
      id="agent-system-prompt"
      label="Instructions"
    >
      <Textarea
        autoComplete="off"
        className={['resize-none', highlight(form, 'systemPrompt')].filter(Boolean).join(' ')}
        mono
        onChange={(event) => form.actions.setSystemPrompt(event.target.value)}
        placeholder="Instructions for the agent…"
        rows={12}
        size="compact"
        value={form.state.systemPrompt}
      />
    </FormField>
  </fieldset>
)

export const AgentMannerFields = ({ form, readOnly }: FieldsProps) => (
  <AgentMannerField
    disabled={readOnly}
    onSpeakingStyleChange={form.actions.setSpeakingStyle}
    speakingStyle={form.state.speakingStyle}
  />
)

// Reasoning effort maps only to the provider's reasoning effort — how hard the
// model thinks per turn. What a task may spend is Run limits' question.
const EFFORTS: { hint: string; label: string; value: AgentEffortValue }[] = [
  { hint: 'no separate thinking where the model can switch it off', label: 'Off', value: 'none' },
  { hint: 'quick, shallow reasoning', label: 'Low', value: 'low' },
  { hint: 'balanced — default', label: 'Medium', value: 'medium' },
  { hint: 'thorough multi-step reasoning', label: 'High', value: 'high' },
  { hint: 'deepest reasoning the model offers', label: 'Ultra', value: 'xhigh' },
]

export const AgentModelFields = ({ agentId, form, readOnly }: FieldsProps & { agentId?: string }) => (
  <div className="grid gap-5">
    <AgentModelField
      agentId={agentId}
      disabled={readOnly}
      error={form.modelOptionsError}
      loading={form.modelsLoading}
      model={form.state.model}
      onLocalBindingChange={form.setLocalBindingId}
      onSelect={form.onModelSelect}
      options={form.modelOptions}
      provider={form.state.provider}
      selected={form.selectedModel}
      streaming={form.state.streamingField === 'model'}
    />
    <fieldset className="grid gap-5 border-0 p-0" disabled={readOnly}>
      <FormField
        help="How hard the model thinks. It does not limit what a task may spend."
        label="Effort"
      >
        <Select
          onChange={(event) => form.actions.setEffort(event.target.value as AgentEffortValue)}
          value={form.state.effort}
        >
          {EFFORTS.map((effort) => (
            <option key={effort.value} value={effort.value}>
              {`${effort.label} — ${effort.hint}`}
            </option>
          ))}
        </Select>
      </FormField>
    </fieldset>
    <RunLimitsFieldset
      disabled={readOnly}
      onChange={form.actions.setRunLimit}
      value={form.state.runLimits}
    />
    <AgentVoiceField
      disabled={readOnly}
      onVoiceNameChange={form.actions.setVoiceName}
      voiceName={form.state.voiceName}
    />
  </div>
)

/**
 * The to-dos switch. Turning it on or off is an organisation owner's change
 * (the route's own `todosEnabled` gate), so anybody else sees it fixed with
 * who can change it.
 */
export const AgentTodosSetting = ({
  canManageTodos,
  form,
  readOnly,
}: FieldsProps & { canManageTodos: boolean }) => (
  <div className="flex items-start justify-between gap-4">
    <div className="min-w-0">
      <p className="text-sm leading-6 text-[color:var(--tx2)]">
        Give this agent reusable checklists it can work through. Their steps
        are visible to everyone who can see the agent, so keep secrets out of them.
      </p>
      {!canManageTodos && !readOnly ? (
        <p className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
          Only an organisation owner can turn to-dos on or off.
        </p>
      ) : null}
    </div>
    <Switch
      checked={form.state.todosEnabled}
      disabled={!canManageTodos || readOnly}
      label="Enable to-dos for this agent"
      onChange={form.actions.setTodosEnabled}
    />
  </div>
)
