import type { AgentRecord } from '../../../lib/api-client'

type AgentInfoCardProps = {
  agent: AgentRecord
}

const badgeClassName =
  'rounded bg-white/8 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ' +
  'text-[color:var(--tx3)]'

const pillClassName =
  'rounded-full border border-[rgba(124,58,237,0.18)] bg-[rgba(124,58,237,0.12)] ' +
  'px-2 py-0.5 text-[10px] font-semibold text-[#d8b4fe]'

const getGlyph = (agent: AgentRecord): string => {
  const role = agent.role.toLowerCase()
  if (role.includes('research')) return '🔍'
  if (role.includes('write')) return '📝'
  return '⚡'
}

export const AgentInfoCard = ({ agent }: AgentInfoCardProps) => {
  const pills: string[] = []

  if (agent.systemManaged) pills.push('System managed')
  if (agent.surfacePolicy) {
    pills.push(agent.surfacePolicy === 'dm_only' ? 'DM only' : 'Shared surface')
  }
  if (agent.delegationMode) {
    pills.push(agent.delegationMode === 'act_as_requesting_user' ? 'Acts as user' : 'No delegation')
  }
  const providerModel = [agent.provider, agent.model].filter(Boolean).join(' / ')
  if (providerModel) pills.push(providerModel)

  return (
    <section className="mx-5 mt-3 rounded-xl border border-[rgba(124,58,237,0.18)] bg-[rgba(124,58,237,0.08)] px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[rgba(124,58,237,0.18)] text-lg">
          {getGlyph(agent)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-white">{agent.name}</span>
            {agent.systemManaged && (
              <span className={badgeClassName}>system managed</span>
            )}
          </div>
          {agent.role ? (
            <p className="mt-1 text-xs leading-5 text-[color:var(--tx2)]">{agent.role}</p>
          ) : null}
          {pills.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {pills.map((pill) => (
                <span className={pillClassName} key={pill}>
                  {pill}
                </span>
              ))}
            </div>
          )}
          <div className="mt-3 grid gap-2 text-xs leading-5 text-[color:var(--tx2)]">
            {agent.systemPrompt ? (
              <div>
                <span className="font-semibold text-white/85">Prompt preview:</span>{' '}
                {agent.systemPrompt.slice(0, 120).trim()}
                {agent.systemPrompt.length > 120 ? '…' : ''}
              </div>
            ) : null}
            <div>
              <span className="font-semibold text-white/85">Status:</span>{' '}
              {agent.status}
            </div>
            <div>
              <span className="font-semibold text-white/85">Config updated:</span>{' '}
              {new Date(agent.updatedAt).toLocaleString()}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
