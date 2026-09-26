import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAgentMailbox } from '../../../../facades/agent-mailbox/hooks'
import { useAgentStatus, useAgents } from '../../../../facades/agents/hooks'
import { useIsOwner } from '../../../../facades/auth/hooks'
import { useChannels } from '../../../../facades/channels/hooks'
import { isToolEnabled } from '../../../../facades/designer/tool-catalog'
import { useProjects } from '../../../../facades/projects/hooks'
import { useAgentTriggers } from '../../../../facades/triggers/hooks'
import type { AgentRecord } from '../../../../lib/api-client'
import { agentStatusSentence } from '../../../../lib/status-sentences'
import { Notice } from '../../../primitives/Notice'
import { PageBody, Section } from '../../../shared/PageBody'
import { AgentAvailability } from '../AgentAvailability'
import { agentOwnershipLabel } from '../AgentOwnershipState'
import { useAgentEditViewer } from '../agent-edit-authority'
import { PrivateAgentHomeLink } from '../PrivateAgentHomeLink'
import type { AgentPageTab } from './agent-page-tabs'
import { BuiltInAgentNote } from './BuiltInAgentNote'
import type { AgentConfigForm } from './useAgentConfigForm'

type AgentAboutTabProps = {
  agent: AgentRecord
  builtIn: boolean
  canEdit: boolean
  form: AgentConfigForm
  onSelectTab: (tab: AgentPageTab) => void
}

const tabLinkClass = 'text-[color:var(--lnk)] hover:underline'

const TabButton = ({ children, onClick }: { children: string; onClick: () => void }) => (
  <button className={tabLinkClass} onClick={onClick} type="button">{children}</button>
)

const chipClass = [
  'rounded-full border border-[color:var(--sep)] bg-[color:var(--panel-soft)] px-3 py-1',
  'text-xs text-[color:var(--tx2)] hover:border-[color:var(--border-strong)] hover:text-[color:var(--tx)]',
].join(' ')

/** Where the agent works: its rooms, and the projects they belong to. */
const WhereItLives = ({ agent }: { agent: AgentRecord }) => {
  const channels = useChannels()
  const projects = useProjects()
  const rooms = useMemo(
    () => (channels.data ?? []).filter((channel) =>
      agent.channelIds.includes(channel.id) && channel.type !== 'dm'),
    [agent.channelIds, channels.data],
  )
  const projectRows = useMemo(() => {
    const ids = new Set(rooms.map((room) => room.projectId))
    return (projects.data ?? []).filter((project) => ids.has(project.id))
  }, [projects.data, rooms])

  if (agent.visibility === 'private') {
    return (
      <p className="text-sm text-[color:var(--tx2)]">
        Only in its owner’s private conversation.{' '}
        <PrivateAgentHomeLink agent={agent} className={tabLinkClass} />
      </p>
    )
  }
  if (rooms.length === 0) {
    return (
      <p className="text-sm text-[color:var(--tx2)]">
        Not in any channel you can see yet. Add it to a channel from that channel’s members.
      </p>
    )
  }
  return (
    <div className="grid gap-2 text-sm text-[color:var(--tx2)]">
      <div className="flex flex-wrap gap-2">
        {rooms.map((room) => (
          <Link className={chipClass} key={room.id} to={`/channels/${room.id}`}>#{room.label}</Link>
        ))}
      </div>
      {projectRows.length > 0 ? (
        <p>
          In {projectRows.length === 1 ? 'the project' : 'the projects'}{' '}
          {projectRows.map((project, index) => (
            <span key={project.id}>
              {index > 0 ? ', ' : ''}
              <Link className={tabLinkClass} to={`/projects/${project.id}`}>{project.name}</Link>
            </span>
          ))}
          .
        </p>
      ) : null}
    </div>
  )
}

/** Things about this agent somebody has to act on, each with where to act. */
const AttentionItems = ({
  agent,
  builtIn,
  form,
  onSelectTab,
}: Pick<AgentAboutTabProps, 'agent' | 'builtIn' | 'form' | 'onSelectTab'>) => {
  const isOwner = useIsOwner()
  const mailbox = useAgentMailbox(builtIn ? undefined : agent.id)
  const triggers = useAgentTriggers(agent.id, isOwner && !builtIn)
  const stopped = (triggers.data ?? []).filter((trigger) =>
    trigger.status === 'error' || trigger.status === 'needs_reauthorization')
  const modelGone = !form.modelsLoading && Boolean(form.state.model || form.state.provider) && !form.selectedModel
  const items: Array<{ id: string; node: ReactNode }> = []
  if (modelGone) {
    items.push({
      id: 'model',
      node: (
        <>
          Its model is no longer available, so it cannot start new work.{' '}
          <TabButton onClick={() => onSelectTab('settings')}>Choose another in Settings</TabButton>
        </>
      ),
    })
  }
  if (mailbox.data?.status === 'suspended') {
    items.push({
      id: 'mailbox',
      node: <>Its email address is suspended{mailbox.data.statusReason ? `: ${mailbox.data.statusReason}` : '.'}</>,
    })
  }
  if (stopped.length > 0) {
    items.push({
      id: 'schedules',
      node: (
        <>
          {stopped.length === 1 ? 'A schedule has stopped running.' : `${stopped.length} schedules have stopped running.`}{' '}
          <TabButton onClick={() => onSelectTab('schedule')}>Open Schedule</TabButton>
        </>
      ),
    })
  }
  if (items.length === 0) return null
  return (
    <Section title="Needs attention">
      <ul className="grid gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <Notice size="sm" tone="warning">{item.node}</Notice>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/**
 * About: what this agent is, where it works, what it may use, and what needs
 * attention. The page's landing tab for everyone, so it reads well to a
 * person who may not change anything here — every doorway it offers is to a
 * tab or page they can open.
 */
export const AgentAboutTab = ({ agent, builtIn, canEdit, form, onSelectTab }: AgentAboutTabProps) => {
  const viewer = useAgentEditViewer()
  // A built-in agent's live status read is closed (it 404s); the record alone
  // says what state it was last in.
  const { data: status } = useAgentStatus(builtIn ? undefined : agent.id)
  const { data: agents = [] } = useAgents({ scope: 'all' })
  const parent = agent.parentAgentId ? agents.find((candidate) => candidate.id === agent.parentAgentId) : undefined
  const enabledTools = form.toolCatalog.options.filter((option) =>
    isToolEnabled(option, agent.toolPolicy ?? {})).length
  const state = agentStatusSentence(agent.status)
  const modelName = form.selectedModel?.displayName ?? (agent.model || null)
  const ownership = builtIn ? 'Provided by Nessie' : agentOwnershipLabel(agent, viewer)

  return (
    <PageBody>
      {builtIn ? <BuiltInAgentNote /> : null}
      <AttentionItems agent={agent} builtIn={builtIn} form={form} onSelectTab={onSelectTab} />

      <Section title="What it is">
        <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-[color:var(--tx3)]">Role</dt>
          <dd className="text-[color:var(--tx)]">{agent.role}</dd>
          <dt className="text-[color:var(--tx3)]">Who manages it</dt>
          <dd className="text-[color:var(--tx)]">
            {ownership}
            {!canEdit && !builtIn ? (
              <span className="text-[color:var(--tx3)]"> · ask them to change it</span>
            ) : null}
          </dd>
          <dt className="text-[color:var(--tx3)]">Model</dt>
          <dd className="text-[color:var(--tx)]">{modelName ?? 'No model chosen'}</dd>
          {agent.parentAgentId ? (
            <>
              <dt className="text-[color:var(--tx3)]">Started by</dt>
              <dd className="text-[color:var(--tx)]">
                {parent
                  ? <Link className={tabLinkClass} to={`/admin/agents/${parent.id}`}>{parent.name}</Link>
                  : 'An agent you cannot see'}
                <span className="text-[color:var(--tx3)]"> · a helper it created for part of its work</span>
              </dd>
            </>
          ) : null}
        </dl>
        <AgentAvailability
          agentId={agent.id}
          canRepair={canEdit}
          localBindingId={agent.localInferenceBindingId}
          provider={agent.provider}
        />
      </Section>

      {builtIn ? null : (
        <Section title="Where it works">
          <WhereItLives agent={agent} />
        </Section>
      )}

      <Section title="What it may use">
        <div className="flex flex-wrap gap-2">
          <button className={chipClass} onClick={() => onSelectTab('access')} type="button">
            {`${enabledTools} ${enabledTools === 1 ? 'tool' : 'tools'} on`}
          </button>
          {agent.browserEnabled ? (
            <button className={chipClass} onClick={() => onSelectTab('access')} type="button">
              Cloud browser
            </button>
          ) : null}
        </div>
      </Section>

      <Section title="Recent activity">
        <p className="text-sm text-[color:var(--tx2)]">
          {status?.currentToolName ? `Working: using ${status.currentToolName}.` : state.sentence}{' '}
          Last active {new Date(agent.lastActivityAt).toLocaleString()}.
        </p>
        {builtIn ? null : (
          <p className="text-sm">
            <TabButton onClick={() => onSelectTab('activity')}>See its conversations and runs</TabButton>
          </p>
        )}
      </Section>
    </PageBody>
  )
}
