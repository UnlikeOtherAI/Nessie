import type { Dispatch, SetStateAction } from 'react'
import type {
  AgentRecord,
  AgentTriggerRecord,
  ChannelRecord,
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'
import {
  fieldLabelClass,
  getWorkflowInstallationLabel,
  type TriggerFormState,
  type TriggerTargetKind,
} from './trigger-config'

type TriggerMetaFieldsProps = {
  agentChannels: ChannelRecord[]
  agents: AgentRecord[]
  currentTriggerLabel: string
  form: TriggerFormState
  mode: 'create' | 'edit'
  selectedAgent?: AgentRecord
  selectedWorkflowInstallation?: WorkflowInstallationRecord
  setForm: Dispatch<SetStateAction<TriggerFormState>>
  showAgentTarget: boolean
  showTargetChooser: boolean
  showWorkflowTarget: boolean
  templatesById: Map<string, WorkflowTemplateRecord>
  trigger?: AgentTriggerRecord
  nameInputRef: React.RefObject<HTMLInputElement>
  workflowInstallations: WorkflowInstallationRecord[]
}

export const TriggerMetaFields = ({
  agentChannels,
  agents,
  currentTriggerLabel,
  form,
  mode,
  nameInputRef,
  selectedAgent,
  selectedWorkflowInstallation,
  setForm,
  showAgentTarget,
  showTargetChooser,
  showWorkflowTarget,
  templatesById,
  trigger,
  workflowInstallations,
}: TriggerMetaFieldsProps) => (
  <div className="grid gap-4 md:grid-cols-2">
    <div className="grid gap-1.5 md:col-span-2">
      <label className={fieldLabelClass} htmlFor="trigger-name">
        Trigger name
      </label>
      <input
        ref={nameInputRef}
        autoComplete="off"
        className="admin-input"
        id="trigger-name"
        onChange={(nextEvent) =>
          setForm((current) => ({ ...current, name: nextEvent.target.value }))
        }
        placeholder="e.g. Daily pipeline check"
        value={form.name}
      />
    </div>

    <div className="grid gap-1.5 md:col-span-2">
      <label className={fieldLabelClass} htmlFor="trigger-description">
        Description
      </label>
      <textarea
        className="admin-input min-h-24 resize-y"
        id="trigger-description"
        onChange={(nextEvent) =>
          setForm((current) => ({
            ...current,
            description: nextEvent.target.value,
          }))
        }
        placeholder="Optional notes for operators"
        value={form.description}
      />
    </div>

    {showTargetChooser ? (
      <>
        <div className="grid gap-1.5">
          <label className={fieldLabelClass} htmlFor="trigger-target-kind">
            Target kind
          </label>
          <select
            className="admin-input"
            id="trigger-target-kind"
            onChange={(nextEvent) =>
              setForm((current) => ({
                ...current,
                targetKind: nextEvent.target.value as TriggerTargetKind,
              }))
            }
            value={form.targetKind}
          >
            {workflowInstallations.length > 0 ? (
              <option value="workflow">Workflow</option>
            ) : null}
            {agents.length > 0 ? <option value="agent">Agent</option> : null}
          </select>
        </div>

        <div className="grid gap-1.5">
          <label className={fieldLabelClass} htmlFor="trigger-enabled">
            Status
          </label>
          <label className="flex h-full items-center gap-3 rounded-lg border border-[color:var(--sep)] bg-black/10 px-3 py-2 text-sm text-white">
            <input
              checked={form.enabled}
              className="accent-[#7c3aed]"
              id="trigger-enabled"
              onChange={(nextEvent) =>
                setForm((current) => ({
                  ...current,
                  enabled: nextEvent.target.checked,
                }))
              }
              type="checkbox"
            />
            Start enabled
          </label>
        </div>
      </>
    ) : (
      <>
        <div className="grid gap-1.5">
          <div className={fieldLabelClass}>Target</div>
          <div className="admin-input cursor-default opacity-70">
            {trigger?.agentId
              ? selectedAgent?.name ?? `Agent ${trigger.agentId.slice(0, 8)}`
              : selectedWorkflowInstallation
                ? getWorkflowInstallationLabel(
                    selectedWorkflowInstallation,
                    templatesById,
                  )
                : trigger?.workflowInstallationId
                  ? `Workflow ${trigger.workflowInstallationId.slice(0, 8)}`
                  : 'Unknown'}
          </div>
        </div>

        <div className="grid gap-1.5">
          <div className={fieldLabelClass}>Status</div>
          <label className="flex h-full items-center gap-3 rounded-lg border border-[color:var(--sep)] bg-black/10 px-3 py-2 text-sm text-white">
            <input
              checked={form.enabled}
              className="accent-[#7c3aed]"
              onChange={(nextEvent) =>
                setForm((current) => ({
                  ...current,
                  enabled: nextEvent.target.checked,
                }))
              }
              type="checkbox"
            />
            Start enabled
          </label>
        </div>

        {trigger?.agentId ? (
          <div className="grid gap-1.5 md:col-span-2">
            <label className={fieldLabelClass} htmlFor="trigger-edit-channel">
              Channel
            </label>
            <select
              className="admin-input"
              id="trigger-edit-channel"
              onChange={(nextEvent) =>
                setForm((current) => ({
                  ...current,
                  targetChannelId: nextEvent.target.value,
                }))
              }
              value={form.targetChannelId}
            >
              {agentChannels.length === 0 ? (
                <option value="">Bind this agent to a channel first</option>
              ) : null}
              {agentChannels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </>
    )}

    {showAgentTarget ? (
      <>
        <div className="grid gap-1.5">
          <label className={fieldLabelClass} htmlFor="trigger-agent">
            Agent
          </label>
          <select
            className="admin-input"
            id="trigger-agent"
            onChange={(nextEvent) =>
              setForm((current) => ({
                ...current,
                agentId: nextEvent.target.value,
              }))
            }
            value={form.agentId}
          >
            {agents.length === 0 ? <option value="">No agents available</option> : null}
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-1.5">
          <label className={fieldLabelClass} htmlFor="trigger-channel">
            Channel
          </label>
          <select
            className="admin-input"
            id="trigger-channel"
            onChange={(nextEvent) =>
              setForm((current) => ({
                ...current,
                targetChannelId: nextEvent.target.value,
              }))
            }
            value={form.targetChannelId}
          >
            {agentChannels.length === 0 ? (
              <option value="">Bind this agent to a channel first</option>
            ) : null}
            {agentChannels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.label}
              </option>
            ))}
          </select>
        </div>
      </>
    ) : null}

    {showWorkflowTarget ? (
      <div className="grid gap-1.5 md:col-span-2">
        <label className={fieldLabelClass} htmlFor="trigger-workflow-installation">
          Workflow
        </label>
        <select
          className="admin-input"
          id="trigger-workflow-installation"
          onChange={(nextEvent) =>
            setForm((current) => ({
              ...current,
              workflowInstallationId: nextEvent.target.value,
            }))
          }
          value={form.workflowInstallationId}
        >
          {workflowInstallations.length === 0 ? (
            <option value="">No workflow installations available</option>
          ) : null}
          {workflowInstallations.map((installation) => (
            <option key={installation.id} value={installation.id}>
              {getWorkflowInstallationLabel(installation, templatesById)}
            </option>
          ))}
        </select>
      </div>
    ) : null}

    <div className="grid gap-1.5">
      <label className={fieldLabelClass} htmlFor="trigger-type">
        Trigger type
      </label>
      <select
        className="admin-input"
        disabled={mode === 'edit'}
        id="trigger-type"
        onChange={(nextEvent) =>
          setForm((current) => ({
            ...current,
            triggerType: nextEvent.target.value as AgentTriggerRecord['type'],
          }))
        }
        value={form.triggerType}
      >
        <option value="manual">Manual start</option>
        <option value="scheduled">Calendar / cron</option>
        <option value="interval">Repeating interval</option>
        <option value="webhook">Webhook</option>
        <option value="event">System event</option>
      </select>
    </div>

    {mode === 'edit' ? (
      <div className="grid gap-1.5">
        <div className={fieldLabelClass}>Mode</div>
        <div className="admin-input cursor-default opacity-70">
          {currentTriggerLabel}
        </div>
      </div>
    ) : null}
  </div>
)
