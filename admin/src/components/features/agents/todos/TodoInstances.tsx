import { useEffect, useMemo, useState } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { AgentTodoRecord, AgentTodoStepStatus, AgentTodoTemplateRecord } from '@nessie/schemas'

import {
  useCancelAgentTodo,
  useCreateAgentTodo,
  useUpdateAgentTodoStep,
  useRunAgentTodo,
} from '../../../../facades/agent-todos/hooks'
import { useChannels } from '../../../../facades/channels/hooks'
import type { AgentRecord } from '../../../../lib/api-client'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { useToasts } from '../../../../providers/ToastProvider'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { EmptyState } from '../../../shared/EmptyState'
import { QueryState } from '../../../shared/QueryState'
import { useIsOwner } from '../../../shared/OwnerGate'
import { TodoInstanceCard } from './TodoInstanceCard'

type TodoInstancesProps = {
  agent: AgentRecord
  query: UseQueryResult<AgentTodoRecord[]>
  templates: AgentTodoTemplateRecord[]
}

export const TodoInstances = ({
  agent,
  query,
  templates,
}: TodoInstancesProps) => {
  const { me } = useAuthSession()
  const todos = query.data ?? []
  const isOwner = useIsOwner()
  const { pushToast } = useToasts()
  const createTodo = useCreateAgentTodo()
  const updateStep = useUpdateAgentTodoStep()
  const cancelTodo = useCancelAgentTodo()
  const runTodo = useRunAgentTodo()
  const { data: channels = [] } = useChannels()
  const activeTemplates = useMemo(
    () => templates.filter((template) => template.status === 'active'),
    [templates],
  )
  const [templateId, setTemplateId] = useState('')
  const runnableChannels = channels.filter((channel) => agent.channelIds.includes(channel.id))
  const [runChannelId, setRunChannelId] = useState('')

  useEffect(() => {
    if (activeTemplates.some((template) => template.id === templateId)) return
    setTemplateId(activeTemplates[0]?.id ?? '')
  }, [activeTemplates, templateId])
  useEffect(() => {
    if (runnableChannels.some((channel) => channel.id === runChannelId)) return
    setRunChannelId(runnableChannels[0]?.id ?? '')
  }, [runnableChannels, runChannelId])

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

  const run = (todo: AgentTodoRecord) => {
    if (!runChannelId) return
    runTodo.mutate(
      { agentId: agent.id, channelId: runChannelId, todoId: todo.id },
      { onError: (error) => pushToast({ body: error.message, title: 'Could not start to-do' }) },
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
          {/* An empty picker reads as a broken control, so when the agent is
              bound nowhere the select says why instead of rendering blank. */}
          <select
            aria-label="Channel for Run now"
            className="admin-input min-w-48"
            disabled={runnableChannels.length === 0}
            onChange={(event) => setRunChannelId(event.target.value)}
            value={runChannelId}
          >
            {runnableChannels.length === 0 ? (
              <option value="">No channel — bind this agent to one first</option>
            ) : null}
            {runnableChannels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.label}</option>)}
          </select>
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

      <QueryState
        className="py-4"
        emptyLabel="Choose an active template and create a to-do to begin tracking its checklist."
        errorLabel="To-dos could not be loaded."
        isEmpty={todos.length === 0}
        loadingLabel="Loading to-dos…"
        query={query}
      >
        {() => (
          <>
            {openTodos.length > 0 ? (
              <div className="grid gap-3">
                <SectionLabel>Open to-dos</SectionLabel>
                {openTodos.map((todo) => (
                  <TodoInstanceCard
                    agent={agent}
                    currentUserId={me?.user.id}
                    isOwner={isOwner}
                    key={todo.id}
                    onCancel={cancel}
                    onRun={run}
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
                  <TodoInstanceCard
                    agent={agent}
                    currentUserId={me?.user.id}
                    isOwner={isOwner}
                    key={todo.id}
                    onCancel={cancel}
                    onRun={run}
                    onUpdateStep={update}
                    todo={todo}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </QueryState>
    </section>
  )
}
