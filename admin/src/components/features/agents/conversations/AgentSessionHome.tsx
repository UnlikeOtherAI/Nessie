import type { AgentRecord } from '../../../../lib/api-client'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../../shared/AgentAvatar'

export type AgentSessionHomeProps = {
  agent: AgentRecord
  busy: boolean
  error: string | null
  onStart: (message?: string) => void
}

/** The agent's home when no session has been selected. */
export const AgentSessionHome = ({ agent, busy, error, onStart }: AgentSessionHomeProps) => {
  const { token } = useAuthSession()
  const ideas = agent.agentKind === 'personal_assistant'
    ? [
        'Help me plan my next steps',
        'Summarize what I need to know',
        'Find an answer in my projects',
      ]
    : [
        `What can you help me with as ${agent.role}?`,
        'Help me make a plan',
        'Summarize the relevant context',
      ]

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-10" data-testid="agent-session-home">
      <div className="flex w-full max-w-lg flex-col items-center text-center">
        <AgentAvatar agent={agent} size={48} token={token} />
        <h2 className="mt-4 text-xl font-semibold text-[color:var(--tx)]">Talk with {agent.name}</h2>
        <p className="mt-2 text-sm leading-6 text-[color:var(--tx2)]">
          Pick a conversation on the left, or start a new one. Each conversation keeps its own context.
        </p>
        <button
          className="admin-button admin-button-primary mt-6"
          disabled={busy}
          onClick={() => onStart()}
          type="button"
        >
          {busy ? 'Starting…' : 'New conversation'}
        </button>
        {error ? <p className="mt-2 text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
        <div className="mt-9 w-full text-left">
          <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tx3)]">Try asking</p>
          <div className="mt-3 flex flex-col gap-2">
            {ideas.map((idea) => (
              <button
                className="rounded-lg border border-[color:var(--sep)] px-4 py-3 text-left text-sm text-[color:var(--tx)] hover:bg-[color:var(--overlay-weak)]"
                disabled={busy}
                key={idea}
                onClick={() => onStart(idea)}
                type="button"
              >
                {idea}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
