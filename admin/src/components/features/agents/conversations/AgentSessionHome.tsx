import { useAgentConversationSuggestions } from '../../../../facades/agents/hooks'
import { useTranslation } from 'react-i18next'
import type { AgentRecord } from '../../../../lib/api-client'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../../shared/AgentAvatar'

export type AgentSessionHomeProps = {
  channelId: string
  agent: AgentRecord
  busy: boolean
  error: string | null
  onStart: (message?: string) => void
}

/** The agent's home when no session has been selected. */
export const AgentSessionHome = ({ agent, channelId, busy, error, onStart }: AgentSessionHomeProps) => {
  const { t } = useTranslation('agentConversations')
  const { token } = useAuthSession()
  const suggestions = useAgentConversationSuggestions(agent.id, channelId)
  const genericIdeas = agent.agentKind === 'personal_assistant'
    ? [
        t('home.personalIdeaPlan'),
        t('home.personalIdeaSummary'),
        t('home.personalIdeaProjects'),
      ]
    : [
        t('home.agentIdeaRole', { role: agent.role }),
        t('home.agentIdeaPlan'),
        t('home.agentIdeaSummary'),
      ]

  const ideas = !suggestions.isError && suggestions.data?.questions.length === 3
    ? suggestions.data.questions : genericIdeas

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-10" data-testid="agent-session-home">
      <div className="flex w-full max-w-lg flex-col items-center text-center">
        <AgentAvatar agent={agent} size={48} token={token} />
        <h2 className="mt-4 text-xl font-semibold text-[color:var(--tx)]">
          {t('home.talkWith', {
            name: agent.agentKind === 'personal_assistant'
              ? t('room.personalAssistant') : agent.name,
          })}
        </h2>
        <p className="mt-2 text-sm leading-6 text-[color:var(--tx2)]">
          {t('home.description')}
        </p>
        <button
          className="admin-button admin-button-primary mt-6"
          disabled={busy}
          onClick={() => onStart()}
          type="button"
        >
          {busy ? t('starting') : t('newConversation')}
        </button>
        {error ? <p className="mt-2 text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
        <div className="mt-9 w-full text-left">
          <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--tx3)]">
            {t('home.tryAsking')}
          </p>
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
