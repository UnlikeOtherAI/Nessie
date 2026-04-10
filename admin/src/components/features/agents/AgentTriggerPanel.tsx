import {
  useAgentTriggers,
  useFireTrigger,
  usePauseTrigger,
  useResumeTrigger,
  useTriggerHistory,
} from '../../../facades/triggers/hooks'
import type { AgentRecord, AgentTriggerRecord } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { EmptyState } from '../../shared/EmptyState'

type AgentTriggerPanelProps = {
  agent: AgentRecord
}

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const formatTimestamp = (value?: string) =>
  value ? new Date(value).toLocaleString() : '—'

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
        <div>
          <div className="flex items-center gap-2">
            <div className="font-semibold text-white">{trigger.name ?? trigger.type}</div>
            <span
              className={[
                'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em]',
                trigger.status === 'active'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : trigger.status === 'paused'
                    ? 'bg-amber-500/15 text-amber-400'
                    : 'bg-red-500/15 text-red-400',
              ].join(' ')}
            >
              {trigger.status}
            </span>
          </div>
          <div className="mt-1 text-sm text-[color:var(--tx2)]">
            {trigger.description ?? `Target ${trigger.targetChannelId?.slice(0, 8) ?? 'unbound'}`}
          </div>
          <div className="mt-2 grid gap-1 text-xs text-[color:var(--tx3)]">
            <div>Type: {trigger.type}</div>
            <div>Next run: {formatTimestamp(trigger.nextRunAt)}</div>
            <div>Last fired: {formatTimestamp(trigger.lastFiredAt)}</div>
          </div>
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            className="admin-button admin-button-secondary"
            onClick={() => onFire(trigger)}
            type="button"
          >
            Trigger now
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
        <div className={sectionTitle}>Recent deliveries</div>
        <div className="mt-2 grid gap-2">
          {history.length === 0 ? (
            <div className="text-sm text-[color:var(--tx3)]">No deliveries yet</div>
          ) : (
            history.map((delivery) => (
              <div
                key={delivery.id}
                className="rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                    {delivery.status}
                  </span>
                  <span className="text-xs text-[color:var(--tx3)]">
                    {new Date(delivery.createdAt).toLocaleString()}
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

export const AgentTriggerPanel = ({ agent }: AgentTriggerPanelProps) => {
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: triggers = [] } = useAgentTriggers(agent.id, isOwner)
  const pause = usePauseTrigger()
  const resume = useResumeTrigger()
  const fire = useFireTrigger()

  if (!isOwner) {
    return (
      <section className="admin-card p-4">
        <div className={sectionTitle}>Triggers</div>
        <div className="mt-3 text-sm text-[color:var(--tx3)]">Owner access required.</div>
      </section>
    )
  }

  return (
    <section className="admin-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className={sectionTitle}>Triggers</div>
          <div className="mt-1 text-sm text-[color:var(--tx2)]">
            Automatic activation and manual fire controls for this agent.
          </div>
        </div>
        <div className="text-xs text-[color:var(--tx3)]">{triggers.length} configured</div>
      </div>

      <div className="mt-4 grid gap-3">
        {triggers.length === 0 ? (
          <EmptyState>No triggers configured for this agent yet.</EmptyState>
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
