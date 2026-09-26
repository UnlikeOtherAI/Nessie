import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useAgentTriggerActivity,
  useAgentTriggers,
  useFireTrigger,
  usePauseTrigger,
  useReauthorizeTrigger,
  useResumeTrigger,
  useTriggerHistory,
} from '../../../facades/triggers/hooks'
import type {
  AgentRecord,
  AgentTriggerActivityRecord,
  AgentTriggerRecord,
} from '../../../lib/api-client'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import { deliveryStatusSentence, triggerStatusSentence } from '../../../lib/status-sentences'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { EmptyState } from '../../shared/EmptyState'
import { useIsOwner } from '../../../facades/auth/hooks'
import { triggerUrl } from '../../../facades/alerts/trigger-url'
import { TriggerEditorDialog } from '../triggers/TriggerEditorDialog'
import { TriggerRunState } from '../triggers/TriggerRunState'
import { findTriggerActivity, groupTriggers } from '../triggers/trigger-groups'
import {
  TRIGGER_TYPE_ICONS,
  canRunTriggerNow,
  formatTimestamp,
  getScheduleSummary,
  getTriggerHealthMessage,
} from '../triggers/trigger-presentation'
import { useTriggerRegistry } from '../triggers/useTriggersPageState'

type AgentTriggerPanelProps = {
  agent: AgentRecord
  /**
   * What this surface calls the list. The agent page's Schedule tab and a
   * conversation's Triggers tab both render this one panel; the prop exists so
   * a surface with different words does not fork it.
   */
  title?: string
}

type RowActions = {
  onEdit: (trigger: AgentTriggerRecord) => void
  onFire: (trigger: AgentTriggerRecord) => void
  onPause: (triggerId: string) => void
  onReauthorize: (triggerId: string) => void
  onResume: (triggerId: string) => void
}

const RecentDeliveries = ({ triggerId }: { triggerId: string }) => {
  const { data: history = [] } = useTriggerHistory(triggerId, 3)
  if (history.length === 0) {
    return <p className="text-xs text-[color:var(--tx3)]">It has not run yet.</p>
  }
  return (
    <ul className="grid gap-1 text-xs text-[color:var(--tx3)]">
      {history.map((delivery) => (
        <li className="flex flex-wrap items-center gap-2" key={delivery.id}>
          <Pill size="sm" tone={deliveryStatusSentence(delivery.status).tone} uppercase={false}>
            {deliveryStatusSentence(delivery.status).label}
          </Pill>
          <span>{formatTimestamp(delivery.createdAt)}</span>
        </li>
      ))}
    </ul>
  )
}

const TriggerRow = ({
  activity,
  actions,
  trigger,
}: {
  activity: AgentTriggerActivityRecord | undefined
  actions: RowActions
  trigger: AgentTriggerRecord
}) => {
  const status = triggerStatusSentence(trigger.status)
  const healthMessage =
    trigger.status === 'error' || trigger.status === 'needs_reauthorization'
      ? getTriggerHealthMessage(trigger)
      : null

  return (
    <li className="grid gap-3 py-4" data-testid="agent-trigger-row">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <FontAwesomeIcon
            className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-[color:var(--tx3)]"
            icon={TRIGGER_TYPE_ICONS[trigger.type]}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                className="truncate font-semibold text-[var(--tx)] hover:underline"
                to={triggerUrl(trigger.id)}
              >
                {trigger.name ?? getScheduleSummary(trigger)}
              </Link>
              <Pill title={status.sentence} tone={status.tone} uppercase={false}>{status.label}</Pill>
              {/* Configuration state and run state are two different answers —
                  a trigger turned off can still have a run finishing — so they
                  are two chips, never one merged word. */}
              <TriggerRunState activity={activity} />
            </div>
            <p className="mt-1 text-sm text-[color:var(--tx2)]">
              {trigger.description ?? getScheduleSummary(trigger)}
            </p>
            {healthMessage ? (
              <p className="mt-1 text-sm text-[color:var(--danger-text)]" role="status">{healthMessage}</p>
            ) : null}
            <p className="mt-1 text-xs text-[color:var(--tx3)]">
              {trigger.status === 'active' ? `Next run ${formatTimestamp(trigger.nextRunAt)} · ` : ''}
              Last ran {formatTimestamp(trigger.lastFiredAt)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canRunTriggerNow(trigger) ? (
            <button className="admin-button admin-button-secondary" onClick={() => actions.onFire(trigger)} type="button">
              Run now
            </button>
          ) : null}
          {trigger.status === 'needs_reauthorization' ? (
            <button className="admin-button admin-button-primary" onClick={() => actions.onReauthorize(trigger.id)} type="button">
              Reauthorize
            </button>
          ) : trigger.status === 'paused' || trigger.status === 'error' ? (
            <button className="admin-button admin-button-primary" onClick={() => actions.onResume(trigger.id)} type="button">
              Resume
            </button>
          ) : trigger.status === 'active' ? (
            <button className="admin-button admin-button-secondary" onClick={() => actions.onPause(trigger.id)} type="button">
              Pause
            </button>
          ) : null}
          <button className="admin-button admin-button-secondary" onClick={() => actions.onEdit(trigger)} type="button">
            Edit
          </button>
        </div>
      </div>
      <div className="pl-7">
        <SectionLabel size="sm">Recent runs</SectionLabel>
        <div className="mt-1"><RecentDeliveries triggerId={trigger.id} /></div>
      </div>
    </li>
  )
}

/**
 * Everything that wakes one agent — schedules, intervals, board columns,
 * document watches, webhooks, events — with the controls a person runs them
 * by. The agent page's Schedule tab and a conversation's Triggers tab are this
 * one panel; the full trigger page stays one link away for its deliveries and
 * machine access.
 *
 * Creating and editing open the editor here, over the panel, already pointed at
 * this agent — the same way a board column or a document folder opens it — on
 * a draft of its own, so the Automations page's unsent create is never
 * replaced by one begun here.
 *
 * The trigger routes are an organisation owner's (reads included), so anybody
 * else is told who manages them rather than shown an empty list.
 */
export const AgentTriggerPanel = ({ agent, title = 'Schedules' }: AgentTriggerPanelProps) => {
  const isOwner = useIsOwner()
  const { data: triggers = [] } = useAgentTriggers(agent.id, isOwner)
  const { data: activity = [] } = useAgentTriggerActivity(agent.id, isOwner)
  const registry = useTriggerRegistry()
  const pause = usePauseTrigger()
  const resume = useResumeTrigger()
  const reauthorize = useReauthorizeTrigger()
  const fire = useFireTrigger()
  const [editor, setEditor] = useState<{ trigger?: AgentTriggerRecord } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  if (!isOwner) {
    return (
      <section className="grid gap-2" data-testid="agent-trigger-panel">
        <SectionLabel>{title}</SectionLabel>
        <p className="text-sm text-[color:var(--tx2)]">
          Only an organisation owner can see and change what wakes {agent.name}.
        </p>
      </section>
    )
  }

  const onError = (fallback: string) => (error: unknown) => setActionError(formErrorMessage(error, fallback))
  const actions: RowActions = {
    onEdit: (trigger) => setEditor({ trigger }),
    onFire: (trigger) => {
      setActionError(null)
      fire.mutate({
        payload: { agentId: agent.id, triggerType: trigger.type },
        prompt: `Run ${agent.name} from its schedule.`,
        triggerId: trigger.id,
      }, { onError: onError('It could not be started.') })
    },
    onPause: (triggerId) => pause.mutate(triggerId),
    onReauthorize: (triggerId) => {
      setActionError(null)
      reauthorize.mutate({ triggerId }, { onError: onError('It could not be reauthorized.') })
    },
    onResume: (triggerId) => {
      setActionError(null)
      resume.mutate(triggerId, { onError: onError('It could not be resumed.') })
    },
  }
  const groups = groupTriggers(triggers)

  return (
    <section className="grid gap-6" data-testid="agent-trigger-panel">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[color:var(--sep)] pb-3">
        <div>
          <SectionLabel>{title}</SectionLabel>
          <p className="mt-1 text-sm text-[color:var(--tx2)]">What wakes {agent.name}, and when it last ran.</p>
        </div>
        {/* Present whether or not there are any: "add another" is as ordinary
            an intent as "add the first". */}
        <button
          className="admin-button admin-button-primary"
          data-testid="agent-trigger-create"
          onClick={() => setEditor({})}
          type="button"
        >
          New schedule
        </button>
      </div>
      {actionError ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{actionError}</p> : null}

      {groups.length === 0 ? (
        <EmptyState>Nothing wakes {agent.name} on its own yet.</EmptyState>
      ) : (
        groups.map((group) => (
          <div className="grid gap-1" data-testid={`trigger-group-${group.key}`} key={group.key}>
            <SectionLabel>{group.title}</SectionLabel>
            <p className="text-xs text-[color:var(--tx3)]">{group.description}</p>
            <ul className="grid divide-y divide-[color:var(--sep)]">
              {group.triggers.map((trigger) => (
                <TriggerRow
                  actions={actions}
                  activity={findTriggerActivity(activity, trigger.id)}
                  key={trigger.id}
                  trigger={trigger}
                />
              ))}
            </ul>
          </div>
        ))
      )}

      <TriggerEditorDialog
        agents={registry.agents}
        channels={registry.channels}
        defaultTarget={{ agentId: agent.id, targetKind: 'agent' }}
        draftId={`agent:${agent.id}`}
        onClose={() => setEditor(null)}
        onSaved={() => setEditor(null)}
        open={editor !== null}
        {...(editor?.trigger ? { trigger: editor.trigger } : {})}
        workflowInstallations={registry.workflowInstallations}
        workflowTemplates={registry.workflowTemplates}
      />
    </section>
  )
}
