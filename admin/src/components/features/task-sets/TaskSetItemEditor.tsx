import { useMemo } from 'react'
import type { TaskSetItemRecord } from '@nessie/schemas'
import { useDraft, draftKey } from '../../../navigation/useDraft'
import { useAddTaskSetItem, useUpdateTaskSetItem } from '../../../facades/task-sets/hooks'
import { taskSetKeys } from '../../../facades/task-sets/keys'
import { usePagedList } from '../../../facades/pagination/usePagedList'
import { useFormSubmit } from '../../../facades/forms/form-errors'
import { FormField } from '../../shared/FormField'
import { Select, Textarea } from '../../shared/FormControls'
import { FormActions, FormError } from '../../shared/FormActions'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { QueryState } from '../../shared/QueryState'

export const TaskSetItemEditor = ({ setId, item, onSaved }: {
  setId: string
  item?: TaskSetItemRecord
  onSaved: () => void
}) => {
  const add = useAddTaskSetItem(setId)
  const update = useUpdateTaskSetItem(setId, item?.id ?? '')
  const initial = useMemo(() => ({
    clientKey: crypto.randomUUID(), prompt: item?.prompt ?? '', dependencies: item?.dependencies ?? [],
    inputType: item?.input && typeof item.input !== 'string' ? 'json' : 'text',
    inputText: typeof item?.input === 'string' ? item.input : item?.input ? JSON.stringify(item.input, null, 2) : '',
  }), [item?.prompt, item?.dependencies, item?.input])
  const { draft, setDraft, clear } = useDraft(draftKey('task-set-item', `${setId}:${item?.id ?? 'new'}`), { initial })
  const preceding = usePagedList<TaskSetItemRecord>({
    path: `/api/task-sets/${setId}/items`, queryKey: taskSetKeys.items(setId), paramPrefix: 'prerequisites-',
  })
  const submit = useFormSubmit(async (values: typeof draft) => {
    const input = values.inputType === 'json' && values.inputText.trim()
      ? JSON.parse(values.inputText) as unknown : values.inputText
    const payload = { prompt: values.prompt, input, dependencies: values.dependencies }
    if (item) return update.mutateAsync(payload)
    return add.mutateAsync({ ...payload, clientKey: values.clientKey })
  })
  return (
    <form className="grid gap-4" onSubmit={(event) => {
      event.preventDefault()
      void submit.submit(draft).then((saved) => {
        if (!saved) return
        clear({ ...initial, clientKey: crypto.randomUUID() })
        onSaved()
      })
    }}>
      <FormField error={submit.fieldErrors.prompt} label="Item instructions" required>
        <Textarea onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
          rows={4} value={draft.prompt} />
      </FormField>
      <FormField label="Input type">
        <Select onChange={(event) => setDraft({ ...draft, inputType: event.target.value })} value={draft.inputType}>
          <option value="text">Text</option><option value="json">JSON</option>
        </Select>
      </FormField>
      <FormField error={submit.fieldErrors.input} label="Input data">
        <Textarea onChange={(event) => setDraft({ ...draft, inputText: event.target.value })}
          rows={5} value={draft.inputText} />
      </FormField>
      <QueryState errorLabel="Earlier items could not be loaded." loadingLabel="Loading earlier items…" query={preceding.query}>
        {() => <>
          <FormField error={submit.fieldErrors.dependencies} help="These results are passed to this item. Only earlier items can be selected."
            label="Add a prerequisite">
            <Select onChange={(event) => {
              if (!event.target.value) return
              setDraft({ ...draft, dependencies: [...new Set([...draft.dependencies, event.target.value])] })
            }} value="">
              <option value="">Choose an earlier item</option>
              {preceding.items.filter((candidate) => !item || candidate.sequence < item.sequence).map((candidate) =>
                <option disabled={draft.dependencies.includes(candidate.id)} key={candidate.id} value={candidate.id}>
                  Item {candidate.sequence}: {candidate.sourceLocator ?? candidate.prompt.slice(0, 80)}
                </option>,
              )}
            </Select>
          </FormField>
          <PaginationFooter {...preceding} hideWhenSinglePage />
        </>}
      </QueryState>
      {draft.dependencies.length ? <ul className="grid gap-2" aria-label="Selected prerequisites">
        {draft.dependencies.map((id) => <li className="flex items-center justify-between gap-3" key={id}>
          <span className="text-sm">{preceding.items.find((candidate) => candidate.id === id)?.prompt || `Item ${id.slice(0, 8)}`}</span>
          <button aria-label={`Remove prerequisite ${id.slice(0, 8)}`} className="admin-button admin-button-secondary"
            onClick={() => setDraft({ ...draft, dependencies: draft.dependencies.filter((entry) => entry !== id) })} type="button">Remove</button>
        </li>)}
      </ul> : null}
      <FormError>{submit.formError}</FormError>
      <FormActions>
        <button className="admin-button admin-button-primary" disabled={submit.isPending} type="submit">
          {submit.isPending ? 'Saving…' : item ? 'Save item' : 'Add item'}
        </button>
      </FormActions>
    </form>
  )
}
