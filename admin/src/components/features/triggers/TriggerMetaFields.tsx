import type { Dispatch, RefObject, SetStateAction } from 'react'
import type {
  AgentRecord,
  AgentTriggerRecord,
  ChannelRecord,
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'
import {
  fieldLabelClass,
  type TriggerFormState,
  type TriggerTargetKind,
} from './trigger-config'
import { getWorkflowInstallationLabel } from './trigger-presentation'
import { TriggerTypePicker } from './TriggerTypePicker'
import { agentSelectionLabel } from '../../shared/AgentVisibilityPill'

/**
 * Identity portion of the trigger editor, ordered by decision weight:
 * name → what kind of trigger → what it targets. Optional metadata
 * (description) and the enabled state live outside this block, after the
 * type-specific configuration.
 */

type TriggerMetaFieldsProps = {
  /** The channels this type may target: every bound one, or for a ticket trigger the public project ones. */
  agentChannels: ChannelRecord[]
  /** Why the channel list is narrower than the agent's rooms, and a server refusal of it. */
  channelHint?: string
  channelError?: string
  channelEmptyLabel?: string
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
  /** Opened on one type by a doorway: the type and the target kind are not the person's to change. */
  typeLocked?: boolean
  templatesById: Map<string, WorkflowTemplateRecord>
  trigger?: AgentTriggerRecord
  nameInputRef: RefObject<HTMLInputElement | null>
  workflowInstallations: WorkflowInstallationRecord[]
}

/** Why the channel list is what it is, and the server's refusal of the choice, under the select. */
const ChannelNote = ({ error, hint }: { error?: string; hint?: string }) => (
  <>
    {hint ? <p className="text-xs text-[color:var(--tx3)]">{hint}</p> : null}
    {error ? (
      <p className="text-xs text-[color:var(--danger-text)]" data-field-error="targetChannelId" role="alert">
        {error}
      </p>
    ) : null}
  </>
)

export const TriggerMetaFields = ({
  agentChannels,
  channelEmptyLabel = 'Bind this agent to a channel first',
  channelError,
  channelHint,
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
  typeLocked = false,
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

    {mode === 'create' && !typeLocked ? (
      <div className="grid gap-1.5 md:col-span-2">
        <div className={fieldLabelClass}>Trigger type</div>
        <TriggerTypePicker
          offerTicketChanged={form.targetKind === 'agent'}
          onChange={(nextType) =>
            setForm((current) => ({ ...current, triggerType: nextType }))
          }
          value={form.triggerType}
        />
      </div>
    ) : (
      <div className="grid gap-1.5">
        <div className={fieldLabelClass}>Trigger type</div>
        <div className="admin-input cursor-default opacity-70">
          {currentTriggerLabel}
        </div>
      </div>
    )}

    {showTargetChooser && typeLocked ? (
      <div className="grid gap-1.5">
        <div className={fieldLabelClass}>Target kind</div>
        <div className="admin-input cursor-default opacity-70">Agent</div>
      </div>
    ) : showTargetChooser ? (
      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="trigger-target-kind">
          Target kind
        </label>
        <select
          className="admin-input"
          id="trigger-target-kind"
          onChange={(nextEvent) =>
            setForm((current) => {
              const targetKind = nextEvent.target.value as TriggerTargetKind
              // A ticket trigger wakes an agent; a workflow cannot hold one.
              const triggerType = targetKind === 'workflow' && current.triggerType === 'ticket_changed'
                ? 'manual'
                : current.triggerType
              return { ...current, targetKind, triggerType }
            })
          }
          value={form.targetKind}
        >
          {workflowInstallations.length > 0 ? (
            <option value="workflow">Workflow</option>
          ) : null}
          {agents.length > 0 ? <option value="agent">Agent</option> : null}
        </select>
      </div>
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

        {trigger?.agentId ? (
          <div className="grid gap-1.5">
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
                <option value="">{channelEmptyLabel}</option>
              ) : null}
              {agentChannels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.label}
                </option>
              ))}
            </select>
            <ChannelNote error={channelError} hint={channelHint} />
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
                {agentSelectionLabel(agent.name, agent.visibility)}
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
              <option value="">{channelEmptyLabel}</option>
            ) : null}
            {agentChannels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.label}
              </option>
            ))}
          </select>
          <ChannelNote error={channelError} hint={channelHint} />
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
  </div>
)
