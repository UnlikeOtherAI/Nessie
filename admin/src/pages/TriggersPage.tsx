import { useMemo } from 'react'
import { useUpcomingTriggers, useTriggers } from '../facades/triggers/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const formatTimestamp = (value?: string) =>
  value ? new Date(value).toLocaleString() : '—'

const formatTriggerTarget = (trigger: {
  agentId?: string
  workflowInstallationId?: string
}): string => {
  if (trigger.agentId) return `agent ${trigger.agentId.slice(0, 8)}`
  if (trigger.workflowInstallationId)
    return `workflow ${trigger.workflowInstallationId.slice(0, 8)}`
  return 'unassigned'
}

export const TriggersPage = () => {
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: triggers = [] } = useTriggers(isOwner)
  const { data: scheduled = [] } = useUpcomingTriggers(isOwner)

  const activeCount = useMemo(
    () => triggers.filter((trigger) => trigger.status === 'active').length,
    [triggers],
  )

  if (!isOwner) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner access required
      </section>
    )
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-[50px] items-center gap-4 border-b border-[color:var(--sep)] px-5">
        <div className={sectionTitle}>Triggers</div>
        <div className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-[color:var(--tx2)]">
          {activeCount} active
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="admin-card p-4">
            <div className={sectionTitle}>All triggers</div>
            <div className="mt-3 grid gap-3">
              {triggers.map((trigger) => (
                <div
                  key={trigger.id}
                  className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold text-white">
                        {trigger.name ?? trigger.type}
                      </div>
                      <div className="text-xs text-[color:var(--tx3)]">
                        {formatTriggerTarget(trigger)} · {trigger.type}
                      </div>
                    </div>
                    <span className="text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                      {trigger.status}
                    </span>
                  </div>
                  <div className="mt-2 text-sm text-[color:var(--tx2)]">
                    Next run: {formatTimestamp(trigger.nextRunAt)}
                  </div>
                </div>
              ))}
              {triggers.length === 0 && (
                <div className="py-8 text-center text-[color:var(--tx3)]">
                  No triggers yet
                </div>
              )}
            </div>
          </div>

          <div className="admin-card p-4">
            <div className={sectionTitle}>Scheduled queue</div>
            <div className="mt-3 grid gap-3">
              {scheduled.map((trigger) => (
                <div
                  key={trigger.id}
                  className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-3"
                >
                  <div className="font-semibold text-white">{trigger.name ?? trigger.type}</div>
                  <div className="mt-1 text-xs text-[color:var(--tx3)]">
                    {trigger.type} · {formatTimestamp(trigger.nextRunAt)}
                  </div>
                </div>
              ))}
              {scheduled.length === 0 && (
                <div className="py-8 text-center text-[color:var(--tx3)]">
                  No scheduled triggers in queue
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
