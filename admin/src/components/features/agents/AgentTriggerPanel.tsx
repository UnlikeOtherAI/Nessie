import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Link, useNavigate } from 'react-router-dom'
import {
  useAgentTriggerActivity,
  useAgentTriggers,
  useFireTrigger,
  usePauseTrigger,
  useResumeTrigger,
  useTriggerHistory,
} from '../../../facades/triggers/hooks'
import type {
  AgentRecord,
  AgentTriggerActivityRecord,
  AgentTriggerRecord,
} from '../../../lib/api-client'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { EmptyState } from '../../shared/EmptyState'
import { useIsOwner } from '../../shared/OwnerGate'
import { TriggerRunState } from '../triggers/TriggerRunState'
import { findTriggerActivity, groupTriggers } from '../triggers/trigger-groups'
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
   * the rest of its configuration vocabulary; a conversation's Triggers tab
   * says the same. One component, one label — the prop exists so a surface
   * with different words does not fork the panel.
   */
  title?: string
}

const TriggerRow = ({
  activity,
  onFire,
  onPause,
  onResume,
  trigger,
}: {
  activity: AgentTriggerActivityRecord | undefined
  onFire: (trigger: AgentTriggerRecord) => void
  onPause: (triggerId: string) => void
  onResume: (triggerId: string) => void
  trigger: AgentTriggerRecord
}) => {
  const { data: history = [] } = useTriggerHistory(trigger.id, 3)

  return (
    <div className="admin-card p-4" data-testid="agent-trigger-row">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--overlay-weak)] text-[color:var(--tx2)]">
            <FontAwesomeIcon className="h-3.5 w-3.5" icon={TRIGGER_TYPE_ICONS[trigger.type]} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                className="truncate font-semibold text-[var(--tx)] hover:underline"
                to={`/agents/triggers#trigger-${encodeURIComponent(trigger.id)}`}
              >
                {trigger.name ?? trigger.type}
              </Link>
              <Pill tone={getTriggerTone(trigger.status)}>{trigger.status}</Pill>
              {/* Configuration state and run state are two different answers —
                  a paused trigger can still have a run finishing — so they are
                  two chips, never one merged word. */}
              <TriggerRunState activity={activity} />
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
  const navigate = useNavigate()
  const isOwner = useIsOwner()
  const { data: triggers = [] } = useAgentTriggers(agent.id, isOwner)
  const { data: activity = [] } = useAgentTriggerActivity(agent.id, isOwner)
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

  const groups = groupTriggers(triggers)

  return (
    <section className="grid gap-6" data-testid="agent-trigger-panel">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[color:var(--sep)] pb-3">
        <div>
          <SectionLabel>{title}</SectionLabel>
          <div className="mt-1 text-sm text-[color:var(--tx2)]">
            Automatic activation and manual fire controls for this agent.
          </div>
        </div>
        {/* The doorway, present whether or not this agent already has
            triggers: "add another" is as ordinary an intent as "add the
            first", and a control that appears only in an empty state is one a
            person has to empty the list to find again. It carries the agent,
            so the Triggers page opens its create form already pointed here
            rather than at a list to hunt through. */}
        <div className="flex items-center gap-3">
          <span className="text-xs text-[color:var(--tx3)]">{triggers.length} configured</span>
          <button
            className="admin-button admin-button-primary"
            data-testid="agent-trigger-create"
            onClick={() =>
              void navigate(`/agents/triggers?create=${encodeURIComponent(agent.id)}`)}
            type="button"
          >
            New trigger
          </button>
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyState>
          Nothing runs automatically for {agent.name} yet.
        </EmptyState>
      ) : (
        groups.map((group) => (
          <div className="grid gap-3" data-testid={`trigger-group-${group.key}`} key={group.key}>
            <div>
              <SectionLabel>{group.title}</SectionLabel>
              <p className="mt-1 text-xs text-[color:var(--tx3)]">{group.description}</p>
            </div>
            {group.triggers.map((trigger) => (
              <TriggerRow
                activity={findTriggerActivity(activity, trigger.id)}
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
            ))}
          </div>
        ))
      )}
    </section>
  )
}
