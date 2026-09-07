import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { AgentTodoTemplateRecord } from '@nessie/schemas'
import { EmptyState } from '../../../shared/EmptyState'
import { FormField } from '../../../shared/FormField'
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
      (await apiClient.get<AgentTodoTemplateRecord[]>(`/api/agents/${agent.id}/todo-templates`))
        .filter((template) => template.status === 'active')
        .map((template) => ({ agentId: agent.id, agentName: agent.name, template })),
    ))).flat(),
  })
  const selected = useMemo(() => templates.data?.find((item) => `${item.agentId}:${item.template.id}` === choice), [choice, templates.data])
  if (checklist.isLoading) return <p className="text-sm text-[color:var(--tx2)]">Loading checklist…</p>
  if (!checklist.data) return <section className="grid gap-4"><EmptyState>This task has no checklist yet.</EmptyState><FormField label="Apply a reusable checklist"><Select aria-label="Checklist template" onChange={(event) => setChoice(event.target.value)} value={choice}><option value="">Choose a template</option>{templates.data?.map((item) => <option key={`${item.agentId}:${item.template.id}`} value={`${item.agentId}:${item.template.id}`}>{item.agentName} — {item.template.name}</option>)}</Select></FormField><div className="flex items-center justify-between gap-3"><Link className="text-sm underline" to="/agents">Manage templates in the agent’s To-dos</Link><button className="admin-button admin-button-primary" disabled={!selected || apply.isPending} onClick={() => selected && void apply.mutateAsync({ agentId: selected.agentId, taskId, templateId: selected.template.id })} type="button">Apply checklist</button></div></section>
  return <section className="grid gap-4" data-testid="task-checklist"><h3 className="text-sm font-semibold text-[color:var(--tx)]">{checklist.data.title}</h3>{checklist.data.steps.map((step) => <div className="grid gap-2 border-b border-[color:var(--sep)] pb-4" key={step.id}><label className="flex gap-2 text-sm"><Input aria-label={`Complete ${step.title}`} checked={Boolean(step.completedAt)} onChange={(event) => void updateStep.mutateAsync({ completed: event.target.checked, result: results[step.key] || step.result, stepKey: step.key, taskId })} type="checkbox" /><span><strong>{step.title}</strong><br />{step.instructions}</span></label><Textarea aria-label={`Result for ${step.title}`} onChange={(event) => setResults((current) => ({ ...current, [step.key]: event.target.value }))} placeholder="What did you find?" rows={2} value={results[step.key] ?? step.result ?? ''} /></div>)}</section>
}
