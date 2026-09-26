import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AgentMessage, AgentMessagePage } from '@nessie/schemas'
import { useAgentMailbox } from '../../../../facades/agent-mailbox/hooks'
import { useAgentTodoTemplates, useAgentTodos } from '../../../../facades/agent-todos/hooks'
import { useAgentActivity, useAgentChildren, useAgentStatus } from '../../../../facades/agents/hooks'
import { agentKeys } from '../../../../facades/agents/keys'
import { usePagedList, usePagedListReset } from '../../../../facades/pagination/usePagedList'
import type { AgentRecord } from '../../../../lib/api-client'
import { agentStatusSentence } from '../../../../lib/status-sentences'
import { PageBody, Section } from '../../../shared/PageBody'
import { PaginationFooter } from '../../../shared/PaginationFooter'
import { QueryState } from '../../../shared/QueryState'
import { AgentMessagePreview } from '../AgentMessagePreview'
import { AgentRunFailuresPanel } from '../AgentRunFailuresPanel'
import { SubAgentTree } from '../SubAgentTree'
import { ToolExecutionLog } from '../ToolExecutionLog'
import { AgentConversationList } from '../conversations/AgentConversationList'
import { TodoInstances } from '../todos/TodoInstances'

const foldSummaryClass = 'cursor-pointer text-sm font-medium text-[color:var(--tx2)]'

/** A fold whose content mounts on first open, so a closed one costs no read. */
const LazyFold = ({ children, summary, testId }: { children: ReactNode; summary: string; testId: string }) => {
  const [opened, setOpened] = useState(false)
  return (
    <details data-testid={testId} onToggle={(event) => { if (event.currentTarget.open) setOpened(true) }}>
      <summary className={foldSummaryClass}>{summary}</summary>
      {opened ? children : null}
    </details>
  )
}

const TodoList = ({ agent }: { agent: AgentRecord }) => {
  const templates = useAgentTodoTemplates(agent.id, { enabled: true, includeArchived: true })
  const todos = useAgentTodos(agent.id, true)
  return <TodoInstances agent={agent} query={todos} templates={templates.data ?? []} />
}

/**
 * The raw message log, folded: it repeats what Conversations already shows,
 * and whether to keep it at all is a decision the plan leaves open (§12.4), so
 * it stays reachable here rather than being deleted.
 */
const MessageDetails = ({ agentId }: { agentId: string }) => {
  const resetMessagePage = usePagedListReset('agentMessages-')
  const messageList = usePagedList<AgentMessage, AgentMessagePage>({
    items: (page) => page.items,
    paramPrefix: 'agentMessages-',
    path: `/api/agents/${agentId}/messages`,
    queryKey: agentKeys.messages(agentId),
    scope: agentId,
  })
  const messages = messageList.items
  return (
    <div className="mt-3 grid gap-4">
      <QueryState
        errorLabel="This message page is no longer available. Restart from newest or retry."
        loadingLabel="Loading messages…"
        query={messageList.query}
      >
        {() => <AgentMessagePreview messages={messages} />}
      </QueryState>
      {messageList.query.isError ? (
        <button className="admin-button admin-button-secondary w-fit" onClick={resetMessagePage} type="button">
          Restart from newest
        </button>
      ) : null}
      <PaginationFooter
        canNext={messageList.canNext}
        canPrevious={messageList.canPrevious}
        className="pt-4"
        hideWhenSinglePage
        label={messageList.query.isPending
          ? 'Loading messages'
          : messages.length === 0
            ? 'No visible messages on this page'
            : `${messages.length} visible message${messages.length === 1 ? '' : 's'} on this page`}
        onPageChange={messageList.onPageChange}
        onPageSizeChange={messageList.onPageSizeChange}
        page={messageList.page}
        pageCount={messageList.pageCount}
        pageSize={messageList.pageSize}
      />
    </div>
  )
}

/**
 * Activity: what this agent has done and is doing — its conversations (ticket
 * and document threads folded), its current run, its to-dos, the runs that
 * failed, its mailbox, the helpers it started (only when it has any), and two
 * technical folds: the tool log and the raw message details. The thought
 * stream placeholder that promised a feature nobody built is gone.
 */
export const AgentActivityTab = ({ agent }: { agent: AgentRecord }) => {
  const navigate = useNavigate()
  const { data: status } = useAgentStatus(agent.id)
  const { data: activity } = useAgentActivity(agent.id)
  const { data: childAgents = [] } = useAgentChildren(agent.id)
  const mailbox = useAgentMailbox(agent.id)
  const toolEntries = useMemo(() => {
    if (!activity) return []
    return activity.recentToolCalls.length > 0
      ? activity.recentToolCalls
      : activity.currentRun?.toolCalls ?? []
  }, [activity])
  const now = status?.currentToolName
    ? `Working: using ${status.currentToolName}.`
    : activity?.currentRun
      ? 'Working on a request.'
      : agentStatusSentence(agent.status).sentence

  return (
    <PageBody>
      <Section title="Right now">
        <p className="text-sm text-[color:var(--tx2)]">{now}</p>
      </Section>
      <Section title="Conversations">
        <AgentConversationList agentId={agent.id} />
      </Section>
      {agent.todosEnabled ? (
        <Section title="To-dos">
          <TodoList agent={agent} />
        </Section>
      ) : null}
      <Section title="Runs that failed">
        <AgentRunFailuresPanel agentId={agent.id} />
      </Section>
      {mailbox.data ? (
        <Section title="Mailbox">
          <p className="text-sm text-[color:var(--tx2)]">
            {mailbox.data.address}.{' '}
            <Link className="text-[color:var(--lnk)] hover:underline" to={`/admin/agents/${agent.id}/mailbox`}>
              Open its mail
            </Link>
          </p>
        </Section>
      ) : null}
      {childAgents.length > 0 ? (
        <Section title="Helpers it started">
          <SubAgentTree
            onSelect={(childId) => void navigate(`/admin/agents/${childId}`)}
            subAgents={childAgents}
          />
        </Section>
      ) : null}
      <details data-testid="agent-tool-log">
        <summary className={foldSummaryClass}>Tool log (technical)</summary>
        <div className="mt-3">
          <ToolExecutionLog entries={toolEntries} />
        </div>
      </details>
      <LazyFold summary="Message details (technical)" testId="agent-message-details">
        <MessageDetails agentId={agent.id} />
      </LazyFold>
    </PageBody>
  )
}
