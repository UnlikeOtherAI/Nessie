import type { MailboxConnectionRecord } from '../../../lib/api-client'
import { useAgents } from '../../../facades/agents/queries'
import { useSetMailboxAgentAccess } from '../../../facades/mailbox-connections/hooks'
import { Switch } from '../../primitives/Switch'
import { AgentVisibilityPill } from '../agents/AgentVisibilityPill'

/**
 * Which agents may use this mailbox.
 *
 * A per-agent row rather than a single on/off, because the tool grant on an
 * agent is keyed by tool id and cannot name a mailbox: without this, connecting
 * a second shared mailbox would hand it to every agent that already had the
 * tools. Turning an agent on here is the whole decision, and it is reversible
 * in one click.
 */
export const MailboxAgentAccess = ({
  connection,
}: {
  connection: MailboxConnectionRecord
}) => {
  const agents = useAgents()
  const setAccess = useSetMailboxAgentAccess()
  const granted = new Set(connection.agentIds)
  const rows = (agents.data ?? []).filter((agent) => !agent.systemManaged)

  if (rows.length === 0) {
    return (
      <p className="text-sm text-[color:var(--tx2)]">
        There are no agents to give access to yet.
      </p>
    )
  }

  return (
    <div className="grid gap-2">
      {rows.map((agent) => (
        <div className="flex items-center justify-between gap-3" key={agent.id}>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-sm text-[color:var(--tx)]">{agent.name}</p>
              <AgentVisibilityPill visibility={agent.visibility} />
            </div>
            {agent.role ? (
              <p className="truncate text-xs text-[color:var(--tx3)]">{agent.role}</p>
            ) : null}
          </div>
          <Switch
            checked={granted.has(agent.id)}
            disabled={setAccess.isPending}
            label={`Let ${agent.name} use this mailbox`}
            onChange={(next) =>
              setAccess.mutate({
                agentId: agent.id,
                allowed: next,
                connectionId: connection.id,
              })}
          />
        </div>
      ))}
      <p className="text-xs text-[color:var(--tx3)]">
        An agent also needs the mailbox tools switched on in its own tool list. Access
        here says which mailbox; the tool switch says whether it may use mailboxes at
        all.
      </p>
    </div>
  )
}
