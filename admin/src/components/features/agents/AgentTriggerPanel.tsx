import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Link } from 'react-router-dom'
import {
  useAgentTriggers,
  useFireTrigger,
  usePauseTrigger,
  useResumeTrigger,
  useTriggerHistory,
} from '../../../facades/triggers/hooks'
import type { AgentRecord, AgentTriggerRecord } from '../../../lib/api-client'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { EmptyState } from '../../shared/EmptyState'
import { useIsOwner } from '../../shared/OwnerGate'
import {
  TRIGGER_TYPE_ICONS,
  formatTimestamp,
  getScheduleSummary,
  getTriggerTone,
} from '../triggers/trigger-presentation'

type AgentTriggerPanelProps = {
  agent: AgentRecord
  /**
   * What this surface calls a trigger. The agent page says "Triggers" beside
   * the rest of its configuration vocabulary; a conversation's Routines tab
   * says "Routines", and the heading has to match the tab a person just
   * pressed. One component, two labels — not two panels.
   */
  title?: string
}

const TriggerRow = ({
  onFire,
  onPause,
  onResume,
  trigger,
}: {
  onFire: (trigger: AgentTriggerRecord) => void
  onPause: (triggerId: string) => void
  onResume: (triggerId: string) => void
  trigger: AgentTriggerRecord
}) => {
  const { data: history = [] } = useTriggerHistory(trigger.id, 3)

  return (
    <div className="admin-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--overlay-weak)] text-[color:var(--tx2)]">
            <FontAwesomeIcon className="h-3.5 w-3.5" icon={TRIGGER_TYPE_ICONS[trigger.type]} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link
                className="truncate font-semibold text-[var(--tx)] hover:underline"
                to={`/agents/triggers#trigger-${encodeURIComponent(trigger.id)}`}
              >
                {trigger.name ?? trigger.type}
              </Link>
              <Pill tone={getTriggerTone(trigger.status)}>{trigger.status}</Pill>
            </div>
            <div className="mt-1 text-sm text-[color:var(--tx2)]">
              {trigger.description ?? getScheduleSummary(trigger)}
            </div>
            <div className="mt-2 grid gap-1 text-xs text-[color:var(--tx3)]">
              <div>{getScheduleSummary(trigger)}</div>
              <div>Next run: {formatTimestamp(trigger.nextRunAt)}</div>
              <div>Last fired: {formatTimestamp(trigger.lastFiredAt)}</div>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            className="admin-button admin-button-secondary"
            onClick={() => onFire(trigger)}
            type="button"
          >
            Run now
          </button>
          {trigger.status === 'paused' ? (
            <button
              className="admin-button admin-button-primary"
              onClick={() => onResume(trigger.id)}
              type="button"
            >
              Resume
            </button>
          ) : (
            <button
              className="admin-button admin-button-secondary"
              onClick={() => onPause(trigger.id)}
              type="button"
            >
              Pause
            </button>
          )}
        </div>
      </div>

      <div className="mt-4">
        <SectionLabel>Recent deliveries</SectionLabel>
        <div className="mt-2 grid gap-2">
          {history.length === 0 ? (
            <div className="text-sm text-[color:var(--tx3)]">No deliveries yet</div>
          ) : (
            history.map((delivery) => (
              <div
                key={delivery.id}
                className="rounded-xl border border-[color:var(--sep)] bg-[var(--scrim-weak)] px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <Pill tone={delivery.status === 'failed' ? 'danger' : 'muted'}>
                    {delivery.status}
                  </Pill>
                  <span className="text-xs text-[color:var(--tx3)]">
                    {formatTimestamp(delivery.createdAt)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-[color:var(--tx2)]">
                  {delivery.source ?? 'manual'}
                  {delivery.runId ? ` · run ${delivery.runId.slice(0, 8)}` : ''}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

export const AgentTriggerPanel = ({ agent, title = 'Triggers' }: AgentTriggerPanelProps) => {
  const isOwner = useIsOwner()
  const { data: triggers = [] } = useAgentTriggers(agent.id, isOwner)
  const pause = usePauseTrigger()
  const resume = useResumeTrigger()
  const fire = useFireTrigger()

  if (!isOwner) {
    return (
      <section className="admin-card p-4">
        <SectionLabel>{title}</SectionLabel>
        <div className="mt-3 text-sm text-[color:var(--tx3)]">Owner access required.</div>
      </section>
    )
  }

  return (
    <section className="admin-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <SectionLabel>{title}</SectionLabel>
          <div className="mt-1 text-sm text-[color:var(--tx2)]">
            Automatic activation and manual fire controls for this agent.
          </div>
        </div>
        <div className="text-xs text-[color:var(--tx3)]">{triggers.length} configured</div>
      </div>

      <div className="mt-4 grid gap-3">
        {triggers.length === 0 ? (
          <EmptyState>
            No triggers configured for this agent yet. Create one on the{' '}
            <Link className="underline" to="/agents/triggers">
              Triggers page
            </Link>
            .
          </EmptyState>
        ) : (
          triggers.map((trigger) => (
            <TriggerRow
              key={trigger.id}
              onFire={(selectedTrigger) =>
                fire.mutate({
                  triggerId: selectedTrigger.id,
                  prompt: `Run ${agent.name} from the trigger control panel.`,
                  payload: { agentId: agent.id, triggerType: selectedTrigger.type },
                })}
              onPause={(triggerId) => pause.mutate(triggerId)}
              onResume={(triggerId) => resume.mutate(triggerId)}
              trigger={trigger}
            />
          ))
        )}
      </div>
    </section>
  )
}
