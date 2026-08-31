import { useEffect, useMemo, useState } from 'react'
import type {
  AgentTodoRecord,
  AgentTodoStepStatus,
  AgentTodoTemplateRecord,
} from '@nessie/schemas'
import { Link } from 'react-router-dom'

import {
  useCancelAgentTodo,
  useCreateAgentTodo,
  useUpdateAgentTodoStep,
} from '../../../../facades/agent-todos/hooks'
import type { AgentRecord } from '../../../../lib/api-client'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { useToasts } from '../../../../providers/ToastProvider'
import { Pill } from '../../../primitives/Pill'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { EmptyState } from '../../../shared/EmptyState'
import { useIsOwner } from '../../../shared/OwnerGate'
import {
  changedByLabel,
  formatTodoTimestamp,
  stepStatusTone,
  todoStatusTone,
} from './todo-presentation'

type TodoInstancesProps = {
  agent: AgentRecord
  isLoading: boolean
  loadError?: Error | null
  templates: AgentTodoTemplateRecord[]
  todos: AgentTodoRecord[]
}

const STEP_STATUSES: AgentTodoStepStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]

const canChangeTodo = (
  todo: AgentTodoRecord,
  agent: AgentRecord,
  currentUserId: string | undefined,
  isOwner: boolean,
): boolean =>
  isOwner
  || todo.createdByUserId === currentUserId
  || agent.ownerUserId === currentUserId

const TodoCard = ({
  agent,
  currentUserId,
  isOwner,
  onCancel,
  onUpdateStep,
  todo,
}: {
  agent: AgentRecord
  currentUserId: string | undefined
  isOwner: boolean
  onCancel: (todo: AgentTodoRecord) => void
  onUpdateStep: (todo: AgentTodoRecord, stepKey: string, status: AgentTodoStepStatus) => void
  todo: AgentTodoRecord
}) => {
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
                <p className="mt-2 text-xs text-[color:var(--tx3)]">
                  Last changed by {changedByLabel(step.updatedByActorType)}
                </p>
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

export const TodoInstances = ({
  agent,
  isLoading,
  loadError,
  templates,
  todos,
}: TodoInstancesProps) => {
  const { me } = useAuthSession()
  const isOwner = useIsOwner()
  const { pushToast } = useToasts()
  const createTodo = useCreateAgentTodo()
  const updateStep = useUpdateAgentTodoStep()
  const cancelTodo = useCancelAgentTodo()
  const activeTemplates = useMemo(
    () => templates.filter((template) => template.status === 'active'),
    [templates],
  )
  const [templateId, setTemplateId] = useState('')

  useEffect(() => {
    if (activeTemplates.some((template) => template.id === templateId)) return
    setTemplateId(activeTemplates[0]?.id ?? '')
  }, [activeTemplates, templateId])

  const openTodos = todos.filter((todo) => todo.status === 'open' || todo.status === 'running')
  const recentTodos = todos.filter((todo) => todo.status !== 'open' && todo.status !== 'running')

  const create = () => {
    if (!templateId) return
    createTodo.mutate(
      { agentId: agent.id, templateId },
      {
        onError: (error) => pushToast({
          body: error.message,
          title: 'Could not create to-do',
        }),
      },
    )
  }

  const update = (todo: AgentTodoRecord, stepKey: string, status: AgentTodoStepStatus) => {
    updateStep.mutate(
      { agentId: agent.id, status, stepKey, todoId: todo.id },
      {
        onError: (error) => pushToast({
          body: error.message,
          title: 'Could not update step',
        }),
      },
    )
  }

  const cancel = (todo: AgentTodoRecord) => {
    cancelTodo.mutate(
      { agentId: agent.id, todoId: todo.id },
      {
        onError: (error) => pushToast({
          body: error.message,
          title: 'Could not cancel to-do',
        }),
      },
    )
  }

  return (
    <section className="grid gap-4" data-testid="agent-todo-instances">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionLabel>To-dos</SectionLabel>
          <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
            Start an active template, then keep its checklist up to date here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Active template for a new to-do"
            className="admin-input min-w-48"
            disabled={activeTemplates.length === 0}
            onChange={(event) => setTemplateId(event.target.value)}
            value={templateId}
          >
            {activeTemplates.length === 0 ? <option>No active templates</option> : null}
            {activeTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
          <button
            className="admin-button admin-button-primary"
            disabled={!templateId || createTodo.isPending}
            onClick={create}
            type="button"
          >
            {createTodo.isPending ? 'Creating…' : 'New to-do'}
          </button>
        </div>
      </div>

      {activeTemplates.length === 0 ? (
        <EmptyState>
          No active templates are available. An organization owner can create one above,
          then anyone who can see this agent can start it.
        </EmptyState>
      ) : null}
      {isLoading ? <div className="py-4 text-sm text-[color:var(--tx3)]">Loading to-dos…</div> : null}
      {loadError ? <div className="text-sm text-[color:var(--danger-text)]" role="alert">{loadError.message}</div> : null}
      {!isLoading && !loadError && todos.length === 0 ? (
        <EmptyState>
          Choose an active template and create a to-do to begin tracking its checklist.
        </EmptyState>
      ) : null}

      {openTodos.length > 0 ? (
        <div className="grid gap-3">
          <SectionLabel>Open to-dos</SectionLabel>
          {openTodos.map((todo) => (
            <TodoCard
              agent={agent}
              currentUserId={me?.user.id}
              isOwner={isOwner}
              key={todo.id}
              onCancel={cancel}
              onUpdateStep={update}
              todo={todo}
            />
          ))}
        </div>
      ) : null}

      {recentTodos.length > 0 ? (
        <div className="grid gap-3">
          <SectionLabel>Recent to-dos</SectionLabel>
          {recentTodos.map((todo) => (
            <TodoCard
              agent={agent}
              currentUserId={me?.user.id}
              isOwner={isOwner}
              key={todo.id}
              onCancel={cancel}
              onUpdateStep={update}
              todo={todo}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}
