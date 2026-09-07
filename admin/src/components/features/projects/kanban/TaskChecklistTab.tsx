import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { AgentTodoTemplateRecord } from '@nessie/schemas'
import { MessageMarkdown } from '../../channels/MessageMarkdown'
import { useAgents } from '../../../../facades/agents/queries'
import { agentTodoKeys } from '../../../../facades/agent-todos/keys'
import {
  useApplyTaskChecklist,
  useTaskChecklist,
  useUpdateTaskChecklistStep,
} from '../../../../facades/tasks/hooks'
import { useApiClient } from '../../../../providers/ApiClientProvider'
import { formErrorMessage } from '../../../../facades/forms/form-errors'
import { draftKey, useDraft } from '../../../../navigation/useDraft'
import { Notice } from '../../../primitives/Notice'
import { EmptyState } from '../../../shared/EmptyState'
import { FormField } from '../../../shared/FormField'
import { Select, Textarea } from '../../../shared/FormControls'

type TemplateChoice = {
  agentId: string
  agentName: string
  template: AgentTodoTemplateRecord
}

export const TaskChecklistTab = ({ taskId }: { taskId: string }) => {
  const apiClient = useApiClient()
  const { data: agents = [] } = useAgents()
  const checklist = useTaskChecklist(taskId)
  const apply = useApplyTaskChecklist()
  const updateStep = useUpdateTaskChecklistStep()
  const [choice, setChoice] = useState('')
  const resultsDraft = useDraft<Record<string, string>>(draftKey('task-checklist', taskId), {
    initial: {},
  })
  const [applyError, setApplyError] = useState<string | null>(null)
  const [pendingStepKeys, setPendingStepKeys] = useState<ReadonlySet<string>>(new Set())
  const [saveStatus, setSaveStatus] = useState<Record<string, string>>({})
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({})
  const activeTaskId = useRef(taskId)
  const pendingStepKeysRef = useRef<ReadonlySet<string>>(new Set())
  const resultsRef = useRef(resultsDraft.draft)
  activeTaskId.current = taskId
  resultsRef.current = resultsDraft.draft

  // Step keys are version-local, so a result typed for one task must never
  // appear after the dialog moves to a second task with the same template.
  useEffect(() => {
    setChoice('')
    setApplyError(null)
    pendingStepKeysRef.current = new Set()
    setPendingStepKeys(pendingStepKeysRef.current)
    setSaveStatus({})
    setStepErrors({})
  }, [taskId])

  const templates = useQuery<TemplateChoice[]>({
    enabled: agents.length > 0,
    queryFn: async () => {
      const choices = await Promise.all(
        agents
          .filter((agent) => agent.todosEnabled)
          .map(async (agent) => {
            const agentTemplates = await apiClient.get<AgentTodoTemplateRecord[]>(
              `/api/agents/${agent.id}/todo-templates`,
            )
            return agentTemplates
              .filter((template) => template.status === 'active')
              .map((template) => ({ agentId: agent.id, agentName: agent.name, template }))
          }),
      )
      return choices.flat()
    },
    queryKey: agentTodoKeys.templateChoices(agents.map((agent) => agent.id)),
  })
  const selected = useMemo(
    () => templates.data?.find((item) => `${item.agentId}:${item.template.id}` === choice),
    [choice, templates.data],
  )

  if (checklist.isLoading) {
    return <p className="text-sm text-[color:var(--tx2)]">Loading checklist…</p>
  }
  if (checklist.isError) {
    return <Notice tone="danger">The checklist could not be loaded.</Notice>
  }
  if (!checklist.data) {
    return (
      <section className="grid gap-4">
        <EmptyState>This task has no checklist yet.</EmptyState>
        {templates.isError || applyError ? (
          <Notice tone="danger">
            {applyError ?? 'The checklist could not be applied.'}
          </Notice>
        ) : null}
        <FormField label="Apply a reusable checklist">
          <Select
            aria-label="Checklist template"
            onChange={(event) => setChoice(event.target.value)}
            value={choice}
          >
            <option value="">Choose a template</option>
            {templates.data?.map((item) => (
              <option
                key={`${item.agentId}:${item.template.id}`}
                value={`${item.agentId}:${item.template.id}`}
              >
                {item.agentName} — {item.template.name}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="flex items-center justify-between gap-3">
          <Link
            className="text-sm underline"
            to={selected ? `/agents/${selected.agentId}?agentTab=to-dos` : '/agents'}
          >
            Manage this agent’s templates
          </Link>
          <button
            className="admin-button admin-button-primary"
            disabled={!selected || apply.isPending}
            onClick={() => {
              if (!selected) return
              setApplyError(null)
              void (async () => {
                try {
                  await apply.mutateAsync({
                    agentId: selected.agentId,
                    taskId,
                    templateId: selected.template.id,
                  })
                } catch (cause) {
                  if (activeTaskId.current === taskId) {
                    setApplyError(formErrorMessage(cause, 'The checklist could not be applied.'))
                  }
                }
              })()
            }}
            type="button"
          >
            Apply checklist
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="grid gap-4" data-testid="task-checklist">
      <h3 className="text-sm font-semibold text-[color:var(--tx)]">{checklist.data.title}</h3>
      {checklist.data.steps.map((step) => {
        const result = resultsDraft.draft[step.key] ?? step.result ?? ''
        const pending = pendingStepKeys.has(step.key)
        const save = (completed = Boolean(step.completedAt)) => {
          if (pendingStepKeysRef.current.has(step.key)) return

          const savedResult = result
          const nextPending = new Set(pendingStepKeysRef.current).add(step.key)
          pendingStepKeysRef.current = nextPending
          setPendingStepKeys(nextPending)
          setStepErrors((current) => {
            const next = { ...current }
            delete next[step.key]
            return next
          })
          setSaveStatus((current) => {
            const next = { ...current }
            delete next[step.key]
            return next
          })

          void (async () => {
            try {
              await updateStep.mutateAsync({
                completed,
                result: savedResult || null,
                stepKey: step.key,
                taskId,
              })
              if (activeTaskId.current !== taskId) return

              // A save only removes the exact value it sent. If the person
              // kept typing while it was in flight, their newer draft remains.
              if (resultsRef.current[step.key] === savedResult) {
                resultsDraft.setDraft((current) => {
                  const next = { ...current }
                  delete next[step.key]
                  resultsRef.current = next
                  return next
                })
                setSaveStatus((current) => ({ ...current, [step.key]: 'Saved.' }))
              } else {
                setSaveStatus((current) => ({
                  ...current,
                  [step.key]: 'Saved an earlier version. Save again to keep your latest edit.',
                }))
              }
            } catch (cause) {
              if (activeTaskId.current === taskId) {
                setStepErrors((current) => ({
                  ...current,
                  [step.key]: formErrorMessage(cause, 'The checklist result could not be saved.'),
                }))
              }
            } finally {
              if (activeTaskId.current !== taskId) return
              const next = new Set(pendingStepKeysRef.current)
              next.delete(step.key)
              pendingStepKeysRef.current = next
              setPendingStepKeys(next)
            }
          })()
        }

        return (
          <div className="grid gap-2 border-b border-[color:var(--sep)] pb-4" key={step.id}>
            <label className="flex gap-2 text-sm">
              <input
                aria-label={`Complete ${step.title}`}
                checked={Boolean(step.completedAt)}
                className="mt-0.5 h-4 w-4 flex-none accent-[color:var(--accent)]"
                disabled={pending}
                onChange={(event) => save(event.target.checked)}
                type="checkbox"
              />
              <span>
                <strong>{step.title}</strong>
                <MessageMarkdown renderInlineText={(text) => text}>
                  {step.instructions}
                </MessageMarkdown>
              </span>
            </label>
            <Textarea
              aria-label={`Result for ${step.title}`}
              onChange={(event) => {
                resultsDraft.setDraft((current) => {
                  const next = { ...current, [step.key]: event.target.value }
                  resultsRef.current = next
                  return next
                })
                setSaveStatus((current) => {
                  const next = { ...current }
                  delete next[step.key]
                  return next
                })
              }}
              placeholder="What did you find?"
              rows={2}
              value={result}
            />
            <div>
              <button
                className="admin-button"
                disabled={pending}
                onClick={() => save()}
                type="button"
              >
                {pending ? 'Saving…' : 'Save result'}
              </button>
            </div>
            {saveStatus[step.key] ? (
              <p className="text-sm text-[color:var(--tx2)]" role="status">
                {saveStatus[step.key]}
              </p>
            ) : null}
            {stepErrors[step.key] ? <Notice tone="danger">{stepErrors[step.key]}</Notice> : null}
          </div>
        )
      })}
    </section>
  )
}
