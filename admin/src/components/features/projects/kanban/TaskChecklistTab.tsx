import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { AgentTodoTemplateRecord } from '@nessie/schemas'
import { MessageMarkdown } from '../../../channels/MessageMarkdown'
import { EmptyState } from '../../../shared/EmptyState'
import { FormField } from '../../../shared/FormField'
import { Notice } from '../../../primitives/Notice'
import { Input, Select, Textarea } from '../../../shared/FormControls'
import { useAgents } from '../../../../facades/agents/queries'
import { useApiClient } from '../../../../providers/ApiClientProvider'
import { useApplyTaskChecklist, useTaskChecklist, useUpdateTaskChecklistStep } from '../../../../facades/tasks/hooks'

type TemplateChoice = { agentId: string; agentName: string; template: AgentTodoTemplateRecord }

export const TaskChecklistTab = ({ taskId }: { taskId: string }) => {
  const apiClient = useApiClient()
  const { data: agents = [] } = useAgents()
  const checklist = useTaskChecklist(taskId)
  const apply = useApplyTaskChecklist()
  const updateStep = useUpdateTaskChecklistStep()
  const [choice, setChoice] = useState('')
  const [results, setResults] = useState<Record<string, string>>({})
  const templates = useQuery<TemplateChoice[]>({
    queryKey: ['task-checklist-templates', agents.map((agent) => agent.id)],
    enabled: agents.length > 0,
    queryFn: async () => (await Promise.all(agents.filter((agent) => agent.todosEnabled).map(async (agent) =>
      (await apiClient.get<AgentTodoTemplateRecord[]>(`/api/agents/${agent.id}/todo-templates`)).filter((template) => template.status === 'active').map((template) => ({ agentId: agent.id, agentName: agent.name, template })),
    ))).flat(),
  })
  const selected = useMemo(() => templates.data?.find((item) => `${item.agentId}:${item.template.id}` === choice), [choice, templates.data])
  if (checklist.isLoading) return <p className="text-sm text-[color:var(--tx2)]">Loading checklist…</p>
  if (checklist.isError) return <Notice tone="danger">The checklist could not be loaded.</Notice>
  if (!checklist.data) return <section className="grid gap-4"><EmptyState>This task has no checklist yet.</EmptyState>{templates.isError || apply.isError ? <Notice tone="danger">The checklist could not be applied.</Notice> : null}<FormField label="Apply a reusable checklist"><Select aria-label="Checklist template" onChange={(event) => setChoice(event.target.value)} value={choice}><option value="">Choose a template</option>{templates.data?.map((item) => <option key={`${item.agentId}:${item.template.id}`} value={`${item.agentId}:${item.template.id}`}>{item.agentName} — {item.template.name}</option>)}</Select></FormField><div className="flex items-center justify-between gap-3"><Link className="text-sm underline" to={selected ? `/agents/${selected.agentId}?agentTab=to-dos` : '/agents'}>Manage this agent’s templates</Link><button className="admin-button admin-button-primary" disabled={!selected || apply.isPending} onClick={() => selected && void apply.mutateAsync({ agentId: selected.agentId, taskId, templateId: selected.template.id })} type="button">Apply checklist</button></div></section>
  return <section className="grid gap-4" data-testid="task-checklist"><h3 className="text-sm font-semibold text-[color:var(--tx)]">{checklist.data.title}</h3>{updateStep.isError ? <Notice tone="danger">The checklist result could not be saved.</Notice> : null}{checklist.data.steps.map((step) => { const result = results[step.key] ?? step.result ?? ''; const save = (completed = Boolean(step.completedAt)) => void updateStep.mutateAsync({ completed, result: result || null, stepKey: step.key, taskId }); return <div className="grid gap-2 border-b border-[color:var(--sep)] pb-4" key={step.id}><label className="flex gap-2 text-sm"><Input aria-label={`Complete ${step.title}`} checked={Boolean(step.completedAt)} onChange={(event) => save(event.target.checked)} type="checkbox" /><span><strong>{step.title}</strong><MessageMarkdown renderInlineText={(text) => text}>{step.instructions}</MessageMarkdown></span></label><Textarea aria-label={`Result for ${step.title}`} onChange={(event) => setResults((current) => ({ ...current, [step.key]: event.target.value }))} placeholder="What did you find?" rows={2} value={result} /><div><button className="admin-button" disabled={updateStep.isPending} onClick={() => save()} type="button">Save result</button></div></div> })}</section>
}
