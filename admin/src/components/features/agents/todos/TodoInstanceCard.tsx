import type { AgentTodoRecord, AgentTodoStepStatus } from '@nessie/schemas'
import { Link } from 'react-router-dom'

import type { AgentRecord } from '../../../../lib/api-client'
import { Pill } from '../../../primitives/Pill'
import { ExpandableTable } from '../../../shared/ExpandableTable'
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
  onRun: (todo: AgentTodoRecord) => void
  onUpdateStep: (todo: AgentTodoRecord, stepKey: string, status: AgentTodoStepStatus) => void
  todo: AgentTodoRecord
}

/**
 * One instance as a dense table: a header line carrying the whole summary, then
 * one row per step. The step's instructions are the second line of its own row
 * (clamped) rather than a paragraph block, and its status is a select rather
 * than five buttons — a checklist is a list, so it reads as rows, and a long
 * one stays scannable.
 */
export const TodoInstanceCard = ({
  agent,
  currentUserId,
  isOwner,
  onCancel,
  onRun,
  onUpdateStep,
  todo,
}: TodoInstanceCardProps) => {
  const canChange = canChangeTodo(todo, agent, currentUserId, isOwner)
  const isCancellable = todo.status === 'open' || todo.status === 'running'
  const doneCount = todo.steps.filter((step) => step.status === 'completed').length
  const editable = canChange && todo.status !== 'cancelled'

  return (
    <article className="admin-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
        <h3 className="truncate text-sm font-semibold text-[color:var(--tx)]">{todo.title}</h3>
        <Pill size="sm" tone={todoStatusTone(todo.status)}>{todo.status}</Pill>
        <span className="text-xs text-[color:var(--tx3)]">
          {doneCount}/{todo.steps.length} done · {formatTodoTimestamp(todo.createdAt)}
        </span>
        {todo.threadId ? (
          <Link
            className="text-xs text-[color:var(--thinking)] underline"
            to={`/threads?threadId=${encodeURIComponent(todo.threadId)}`}
          >
            Open thread
          </Link>
        ) : null}
        {isCancellable ? (
          <div className="ml-auto flex shrink-0 gap-2">
            {!todo.activeRunId ? (
              <button className="admin-button admin-button-primary" onClick={() => onRun(todo)} type="button">
                Run now
              </button>
            ) : null}
            {canChange ? (
              <button className="admin-button admin-button-danger" onClick={() => onCancel(todo)} type="button">
                Cancel to-do
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <ExpandableTable label={`Steps for ${todo.title}`}>
        <table className="admin-table w-full border-collapse border-t border-[color:var(--sep)]">
          <tbody>
            {todo.steps.map((step, index) => (
              <tr className="border-t border-[color:var(--sep)]" key={step.id}>
                <td className="w-8 py-2 pl-4 pr-0 align-top text-xs text-[color:var(--tx3)]">
                  {index + 1}
                </td>
                <td className="min-w-0 px-2 py-2">
                  <div className="truncate text-sm font-medium text-[color:var(--tx)]" title={step.title}>
                    {step.title}
                  </div>
                  <div
                    className="truncate text-xs leading-5 text-[color:var(--tx2)]"
                    title={step.instructions}
                  >
                    {step.note ? `${step.note} — ` : ''}{step.instructions}
                  </div>
                </td>
                <td className="hidden whitespace-nowrap px-2 py-2 text-xs text-[color:var(--tx3)] sm:table-cell">
                  {step.updatedByActorType ? changedByLabel(step.updatedByActorType) : 'not changed yet'}
                </td>
                <td className="w-40 py-2 pl-2 pr-4 text-right">
                  {editable ? (
                    <select
                      aria-label={`Status for step ${index + 1}: ${step.title}`}
                      className="admin-input admin-input-sm text-xs"
                      onChange={(event) =>
                        onUpdateStep(todo, step.key, event.target.value as AgentTodoStepStatus)}
                      value={step.status}
                    >
                      {STEP_STATUSES.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                  ) : (
                    <Pill size="sm" tone={stepStatusTone(step.status)}>{step.status}</Pill>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ExpandableTable>
    </article>
  )
}
