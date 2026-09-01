import { z } from 'zod'

import { useAgentTodoById } from '../../../facades/agent-todos/hooks'
import type { AgentTodoRecord } from '@nessie/schemas'
import { Pill } from '../../primitives/Pill'

const TodoRefSchema = z.object({ todoId: z.string().uuid() })

/**
 * Chat metadata deliberately carries only an opaque id. The entitled API read
 * decides whether this viewer may see the checklist; a 404 is rendered as an
 * honest neutral state rather than leaking the original step content.
 */
export const TodoProgressCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const parsed = TodoRefSchema.safeParse(metadata?.todoRef)
  const todoId = parsed.success ? parsed.data.todoId : undefined
  const todoQuery = useAgentTodoById(todoId)

  return <TodoProgressCardView todo={todoQuery.data} todoId={todoId} unavailable={todoQuery.isError} />
}

export const TodoProgressCardView = ({
  todo,
  todoId,
  unavailable,
}: {
  todo: AgentTodoRecord | undefined
  todoId?: string
  unavailable: boolean
}) => {
  if (!todoId) return null
  if (unavailable) {
    return <div className="mt-2 text-xs text-[color:var(--tx3)]" data-testid="todo-progress-unavailable">To-do details are unavailable.</div>
  }
  if (!todo) return <div className="mt-2 text-xs text-[color:var(--tx3)]">Loading to-do…</div>
  const complete = todo.steps.filter((step) => ['completed', 'failed', 'skipped'].includes(step.status)).length

  return (
    <section className="mt-2 rounded-xl border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-3" data-testid="todo-progress-card">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-[color:var(--tx)]">{todo.title}</span>
        <Pill size="sm" tone={todo.status === 'completed' ? 'success' : 'accent'}>{todo.status}</Pill>
      </div>
      <p className="mt-1 text-xs text-[color:var(--tx3)]">{complete}/{todo.steps.length} steps finished</p>
    </section>
  )
}
