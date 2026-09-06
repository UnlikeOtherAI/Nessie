import type { AgentRecord } from '../../../../lib/api-client'
import { useAgentTodoTemplates, useAgentTodos } from '../../../../facades/agent-todos/hooks'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { EmptyState } from '../../../shared/EmptyState'
import { useIsOwner } from '../../../../facades/auth/hooks'
import { TodoInstances } from './TodoInstances'
import { TodoTemplates } from './TodoTemplates'

export const AgentTodosTab = ({ agent }: { agent: AgentRecord }) => {
  const isOwner = useIsOwner()
  const enabled = agent.todosEnabled
  const templatesQuery = useAgentTodoTemplates(agent.id, { enabled, includeArchived: true })
  const todosQuery = useAgentTodos(agent.id, enabled)

  if (!enabled) {
    return (
      <section className="admin-card p-4" data-testid="agent-todos-disabled">
        <SectionLabel>To-dos are off</SectionLabel>
        <EmptyState>
          {isOwner
            ? 'Enable To-dos in the Designer to give this agent reusable checklists.'
            : 'This agent does not have to-dos enabled. An organization owner can enable them in the Designer.'}
        </EmptyState>
      </section>
    )
  }

  const templates = templatesQuery.data ?? []

  return (
    <div className="grid gap-8" data-testid="agent-todos-tab">
      <TodoTemplates agent={agent} query={templatesQuery} />
      <TodoInstances agent={agent} query={todosQuery} templates={templates} />
    </div>
  )
}
