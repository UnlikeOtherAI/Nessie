import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { AgentRecord, AgentTriggerRecord, ChannelRecord } from '../../../../lib/api-client'
import { useCreateAgentTrigger } from '../../../../facades/triggers/hooks'

type ScheduledTodoTemplateProps = {
  agent: AgentRecord
  channels: ChannelRecord[]
  templateId: string
  trigger?: AgentTriggerRecord
}

/** A deliberately small schedule authoring surface over the existing trigger route. */
export const ScheduledTodoTemplate = ({
  agent,
  channels,
  templateId,
  trigger,
}: ScheduledTodoTemplateProps) => {
  const [open, setOpen] = useState(false)

  if (trigger) {
    return (
      <Link
        className="text-xs text-[color:var(--accent)] hover:underline"
        to={`/agents/triggers#trigger-${encodeURIComponent(trigger.id)}`}
      >
        {trigger.status === 'error' || trigger.status === 'needs_reauthorization'
          ? `Schedule needs repair · ${trigger.status}`
          : `Repeats on ${trigger.name ?? 'its schedule'} · ${trigger.status}`}
      </Link>
    )
  }

  if (!open) {
    return (
      <button className="admin-button admin-button-secondary" onClick={() => setOpen(true)} type="button">
        Repeat on a schedule
      </button>
    )
  }

  return (
    <ScheduledTodoTemplateForm
      agent={agent}
      channels={channels}
      onCancel={() => setOpen(false)}
      templateId={templateId}
    />
  )
}

type ScheduledTodoTemplateFormProps = Omit<ScheduledTodoTemplateProps, 'trigger'> & {
  onCancel: () => void
}

const ScheduledTodoTemplateForm = ({
  agent,
  channels,
  onCancel,
  templateId,
}: ScheduledTodoTemplateFormProps) => {
  const createTrigger = useCreateAgentTrigger()
  const [channelId, setChannelId] = useState(agent.channelIds[0] ?? '')
  const [error, setError] = useState<string | null>(null)
  const [intervalHours, setIntervalHours] = useState('24')
  const boundChannels = channels.filter((channel) => agent.channelIds.includes(channel.id))

  const create = async () => {
    const hours = Number(intervalHours)
    if (!channelId || !Number.isFinite(hours) || hours <= 0) return
    setError(null)
    try {
      await createTrigger.mutateAsync({
        agentId: agent.id,
        config: { interval_minutes: Math.round(hours * 60), todoTemplateId: templateId },
        description: 'Runs this to-do template on its recurring schedule.',
        name: `Repeat to-do every ${hours}h`,
        targetChannelId: channelId,
        type: 'interval',
      })
      onCancel()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create schedule.')
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[color:var(--sep)] p-2">
      <label className="grid gap-1 text-xs text-[color:var(--tx2)]">
        Channel
        <select className="admin-input admin-input-compact" onChange={(event) => setChannelId(event.target.value)} value={channelId}>
          {boundChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.label}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-xs text-[color:var(--tx2)]">
        Every (hours)
        <input className="admin-input admin-input-compact w-24" min="1" onChange={(event) => setIntervalHours(event.target.value)} type="number" value={intervalHours} />
      </label>
      <button className="admin-button admin-button-primary" disabled={!channelId || createTrigger.isPending} onClick={() => void create()} type="button">
        {createTrigger.isPending ? 'Scheduling…' : 'Schedule'}
      </button>
      <button className="admin-button admin-button-secondary" onClick={onCancel} type="button">Cancel</button>
      {error ? <p className="basis-full text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
    </div>
  )
}
