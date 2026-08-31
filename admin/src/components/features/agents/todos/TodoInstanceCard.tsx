import type { AgentTodoRecord, AgentTodoStepStatus } from '@nessie/schemas'
import { Link } from 'react-router-dom'

import type { AgentRecord } from '../../../../lib/api-client'
import { Pill } from '../../../primitives/Pill'
import {
  changedByLabel,
  formatTodoTimestamp,
  stepStatusTone,
  todoStatusTone,
} from './todo-presentation'

const STEP_STATUSES: AgentTodoStepStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]

export const canChangeTodo = (
  todo: AgentTodoRecord,
  agent: AgentRecord,
  currentUserId: string | undefined,
  isOwner: boolean,
): boolean =>
  isOwner
  || todo.createdByUserId === currentUserId
  || agent.ownerUserId === currentUserId

type TodoInstanceCardProps = {
  agent: AgentRecord
  currentUserId: string | undefined
  isOwner: boolean
  onCancel: (todo: AgentTodoRecord) => void
  onUpdateStep: (todo: AgentTodoRecord, stepKey: string, status: AgentTodoStepStatus) => void
  todo: AgentTodoRecord
}

export const TodoInstanceCard = ({
  agent,
  currentUserId,
  isOwner,
  onCancel,
  onUpdateStep,
  todo,
}: TodoInstanceCardProps) => {
  const canChange = canChangeTodo(todo, agent, currentUserId, isOwner)
  const isCancellable = todo.status === 'open' || todo.status === 'running'

  return (
    <article className="admin-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-[color:var(--tx)]">{todo.title}</h3>
            <Pill tone={todoStatusTone(todo.status)}>{todo.status}</Pill>
          </div>
          <p className="mt-1 text-xs text-[color:var(--tx3)]">
            Created {formatTodoTimestamp(todo.createdAt)}
          </p>
          {todo.threadId ? (
            <Link
              className="mt-2 inline-flex text-sm text-[color:var(--thinking)] underline"
              to={`/threads?threadId=${encodeURIComponent(todo.threadId)}`}
            >
              Open executing thread
            </Link>
          ) : null}
        </div>
        {canChange && isCancellable ? (
          <button
            className="admin-button admin-button-danger"
            onClick={() => onCancel(todo)}
            type="button"
          >
            Cancel to-do
          </button>
        ) : null}
      </div>

      <ol className="mt-4 grid gap-3">
        {todo.steps.map((step, index) => (
          <li className="rounded-xl border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-3" key={step.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-[color:var(--tx)]">
                    {index + 1}. {step.title}
                  </span>
                  <Pill size="sm" tone={stepStatusTone(step.status)}>{step.status}</Pill>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx2)]">
                  {step.instructions}
                </p>
                {step.updatedByActorType ? (
                  <p className="mt-2 text-xs text-[color:var(--tx3)]">
                    Last changed by {changedByLabel(step.updatedByActorType)}.
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-[color:var(--tx3)]">
                    This step has not been changed yet.
                  </p>
                )}
                {step.note ? (
                  <p className="mt-1 rounded-lg bg-[color:var(--panel)] px-2 py-1.5 text-xs leading-5 text-[color:var(--tx2)]">
                    {step.note}
                  </p>
                ) : null}
              </div>
              {canChange && todo.status !== 'cancelled' ? (
                <div className="flex flex-wrap gap-1.5">
                  {STEP_STATUSES.map((status) => (
                    <button
                      className="admin-button admin-button-secondary"
                      disabled={step.status === status}
                      key={status}
                      onClick={() => onUpdateStep(todo, step.key, status)}
                      type="button"
                    >
                      {status}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </article>
  )
}
