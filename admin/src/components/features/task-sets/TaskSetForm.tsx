import { Link } from 'react-router-dom'
import { TaskSetCreateSchema, type TaskSetCreate, type TaskSetRecord } from '@nessie/schemas'
import { useState } from 'react'
import { useDraft, draftKey } from '../../../navigation/useDraft'
import { useAgents } from '../../../facades/agents/hooks'
import { useChannels } from '../../../facades/channels/hooks'
import { useTaskSetProcessors } from '../../../facades/task-sets/hooks'
import { useFormSubmit } from '../../../facades/forms/form-errors'
import { FormField } from '../../shared/FormField'
import { FormActions, FormError } from '../../shared/FormActions'
import { Input, Select, Textarea } from '../../shared/FormControls'
import { Section } from '../../shared/PageBody'
import { QueryState } from '../../shared/QueryState'
import { TaskSetSourceFields } from './TaskSetSourceFields'
import { TaskSetOutputFields } from './TaskSetOutputFields'

export const TaskSetForm = ({ initial, identity, onSave, onSaved, submitLabel, sourceLocked = false }: {
  sourceLocked?: boolean
  initial: TaskSetCreate
  identity: string
  onSave: (input: TaskSetCreate) => Promise<TaskSetRecord>
  onSaved: (set: TaskSetRecord) => void
  submitLabel: string
}) => {
  const { draft, setDraft, clear, saveError } = useDraft(draftKey('task-set', identity), { initial: {
    ...initial,
    sourceFieldsText: Object.entries(initial.source?.selection.fields ?? {})
      .map(([field, source]) => `${field} = ${source}`).join('\n'),
    resultColumnsText: initial.output.kind === 'spreadsheet'
      ? Object.entries(initial.output.fields).map(([column, field]) => `${column} = ${field}`).join('\n') : '',
  } })
  const [validation, setValidation] = useState<Record<string, string>>({})
  const processors = useTaskSetProcessors()
  const agents = useAgents({ scope: 'all' })
  const channels = useChannels({ enabled: Boolean(draft.receiver) })
  const submit = useFormSubmit(onSave)
  const selected = processors.data?.find((option) => option.provider === draft.processor.provider
    && option.model === draft.processor.model
    && option.localInferenceBindingId === draft.processor.localInferenceBindingId
    && option.modelSubscriptionId === draft.processor.modelSubscriptionId)
  const patch = (values: Partial<TaskSetCreate>) => setDraft((current) => ({ ...current, ...values }))
  const errorFor = (field: string) => validation[field] ?? submit.fieldErrors[field]

  return (
    <form className="grid gap-8" onSubmit={(event) => {
      event.preventDefault()
      const { sourceFieldsText, resultColumnsText, ...input } = draft
      const fields = sourceFieldsText.split('\n').filter((line) => line.trim()).map((line) => {
        const separator = line.indexOf('=')
        const field = separator < 0 ? line.trim() : line.slice(0, separator).trim()
        const source = separator < 0 ? field : line.slice(separator + 1).trim()
        return [field, /^\d+$/.test(source) ? Number(source) : source]
      })
      if (input.source) input.source = { ...input.source, selection: { ...input.source.selection,
        fields: fields.length ? Object.fromEntries(fields) : undefined,
      } }
      if (input.output.kind === 'spreadsheet') input.output = { ...input.output,
        fields: Object.fromEntries(resultColumnsText.split('\n').filter((line) => line.trim()).map((line) => {
          const separator = line.indexOf('=')
          return separator < 0 ? [line.trim(), line.trim()]
            : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
        })),
      }
      const parsed = TaskSetCreateSchema.safeParse(input)
      if (!parsed.success) {
        setValidation(Object.fromEntries(Object.entries(parsed.error.flatten().fieldErrors)
          .map(([field, errors]) => [field, errors?.join(' ') ?? 'Check this field.'])))
        return
      }
      setValidation({})
      void submit.submit(parsed.data).then((set) => {
        if (!set) return
        clear({ ...parsed.data, sourceFieldsText, resultColumnsText })
        onSaved(set)
      })
    }}>
      <Section title="Work">
        <div className="grid gap-4">
          <FormField error={errorFor('name')} label="Name" required>
            <Input onChange={(event) => patch({ name: event.target.value })} value={draft.name} />
          </FormField>
          <FormField error={errorFor('objective')} label="Objective" required>
            <Textarea onChange={(event) => patch({ objective: event.target.value })} rows={3} value={draft.objective} />
          </FormField>
          <FormField error={errorFor('instructions')} help="Applied to every item. Describe the expected result and how to record no findings."
            label="Shared instructions">
            <Textarea onChange={(event) => patch({ instructions: event.target.value })}
              rows={4} value={draft.instructions} />
          </FormField>
        </div>
      </Section>
      <Section title="Runs on">
        <div className="grid gap-4">
          <QueryState errorLabel="Models could not be loaded." loadingLabel="Loading models…" query={processors}>
            {() => <FormField error={errorFor('processor')} help="One item runs at a time. Other batch jobs share the model's available capacity."
              label="Model" required>
              <Select onChange={(event) => {
                const option = processors.data?.find((item) => item.id === event.target.value)
                if (!option) return
                patch({ processor: {
                  provider: option.provider, model: option.model,
                  modelSubscriptionId: option.modelSubscriptionId,
                  localInferenceBindingId: option.localInferenceBindingId,
                } })
              }} value={selected?.id ?? ''}>
                <option value="">Choose a model</option>
                {(processors.data ?? []).map((option) => <option
                  disabled={Boolean(option.setupUrl) && !option.localInferenceBindingId}
                  key={option.id} value={option.id}>
                  {option.label}{option.resourceLabel ? ` · ${option.resourceLabel}` : ''}{option.available ? '' : ' · unavailable'}
                </option>)}
              </Select>
            </FormField>}
          </QueryState>
          {selected?.reason ? <p className="text-sm text-[color:var(--tx2)]">{selected.reason}</p> : null}
          {(processors.data ?? []).some((option) => option.source === 'local' && option.setupUrl) ?
            <Link className="text-sm text-[color:var(--accent)] underline" to="/admin/computers">Set up a local model</Link> : null}
          <FormField label="Research tools">
            <Select onChange={(event) => patch({ search: event.target.value as 'none' | 'processor' })} value={draft.search ?? 'none'}>
              <option value="none">No web research</option>
              <option value="processor">The model's configured search</option>
            </Select>
          </FormField>
          <FormField error={errorFor('maxParallelRequests')} label="Parallel requests across batch jobs"
            help="Each set still runs one item at a time. The lowest active set limit applies to this model; local device capacity may be lower.">
            <Input max={32} min={1} onChange={(event) => patch({ maxParallelRequests: Number(event.target.value) })}
              type="number" value={draft.maxParallelRequests ?? 1} />
          </FormField>
          <FormField help="A failed item stops the set when its attempts are exhausted." label="Maximum attempts per item">
            <Input max={10} min={1} onChange={(event) => patch({ maxAttempts: Number(event.target.value) })}
              type="number" value={draft.maxAttempts ?? 3} />
          </FormField>
        </div>
      </Section>
      <Section title="Input">
        {sourceLocked ? <p className="text-sm text-[color:var(--tx2)]">The input version and selection are fixed for this set.</p> : null}
        <fieldset disabled={sourceLocked}>
        <TaskSetSourceFields fieldsText={draft.sourceFieldsText}
          onFieldsTextChange={(sourceFieldsText) => setDraft({ ...draft, sourceFieldsText })}
          onChange={(source) => patch({ source })} value={draft.source ?? null} />
        </fieldset>
        <FormError>{errorFor('source')}</FormError>
      </Section>
      <Section title="Output">
        <TaskSetOutputFields columnsText={draft.resultColumnsText}
          onColumnsTextChange={(resultColumnsText) => setDraft({ ...draft, resultColumnsText })}
          onChange={(output) => patch({ output })} value={draft.output} />
        <FormError>{errorFor('output')}</FormError>
      </Section>
      <Section title="Hand results to (optional)">
        <div className="grid gap-4">
          <QueryState errorLabel="Agents could not be loaded." loadingLabel="Loading agents…" query={agents}>
            {() => <FormField help="Choose an agent to continue the work after processing. Leave empty to save the results only." label="Agent">
              <Select onChange={(event) => patch({ receiver: event.target.value ? {
                agentId: event.target.value, channelId: draft.receiver?.channelId ?? '',
                instructions: draft.receiver?.instructions ?? '',
              } : null })} value={draft.receiver?.agentId ?? ''}>
                <option value="">None</option>
                {(agents.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.id.slice(0, 8)}
                </option>)}
              </Select>
            </FormField>}
          </QueryState>
          {draft.receiver ? <>
            <QueryState errorLabel="Conversations could not be loaded." loadingLabel="Loading conversations…" query={channels}>
              {() => <FormField label="Conversation" required>
                <Select onChange={(event) => {
                  patch({ receiver: { ...draft.receiver!, channelId: event.target.value } })
                }}
                  value={draft.receiver?.channelId ?? ''}>
                  <option value="">Choose a conversation</option>
                  {(channels.data ?? []).map((channel) =>
                    <option key={channel.id} value={channel.id}>{channel.label}</option>)}
                </Select>
              </FormField>}
            </QueryState>
            <FormField label="Instructions" required>
              <Textarea onChange={(event) => {
                patch({ receiver: { ...draft.receiver!, instructions: event.target.value } })
              }}
                rows={3} value={draft.receiver.instructions} />
            </FormField>
          </> : null}
          <FormError>{errorFor('receiver')}</FormError>
        </div>
      </Section>
      <FormError>{submit.formError ?? saveError}</FormError>
      <FormActions>
        <button className="admin-button admin-button-primary" disabled={submit.isPending} type="submit">
          {submit.isPending ? 'Saving…' : submitLabel}
        </button>
      </FormActions>
    </form>
  )
}
