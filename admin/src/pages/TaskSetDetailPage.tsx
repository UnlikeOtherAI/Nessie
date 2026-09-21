import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { TaskSetAction, TaskSetCreate, TaskSetItemRecord, TaskSetUpdate } from '@nessie/schemas'
import { usePagedList } from '../facades/pagination/usePagedList'
import { localInferenceKeys } from '../facades/local-inference/keys'
import { taskSetKeys } from '../facades/task-sets/keys'
import { useTaskSet, useTaskSetAction, useTaskSetProcessors, useUpdateTaskSet } from '../facades/task-sets/hooks'
import { formErrorMessage } from '../facades/forms/form-errors'
import { PageBody, Section } from '../components/shared/PageBody'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import type { PageHeaderAction } from '../components/shared/ResponsivePageHeader'
import { QueryState } from '../components/shared/QueryState'
import { DataTable } from '../components/shared/DataTable'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { Dialog } from '../components/shared/Dialog'
import { FormError } from '../components/shared/FormActions'
import { TaskSetForm } from '../components/features/task-sets/TaskSetForm'
import { TaskSetItemEditor } from '../components/features/task-sets/TaskSetItemEditor'
import { TaskSetItemDetail } from '../components/features/task-sets/TaskSetItemDetail'
import { LocalInferenceHostStatus } from '../components/features/local-inference/LocalInferenceHostStatus'
import {
  TaskSetStatus, taskSetDocumentPath, taskSetProgress, taskSetTimestamp, taskSetReason,
} from '../components/features/task-sets/presentation'

export const TaskSetDetailPage = () => {
  const { taskSetId = '' } = useParams<{ taskSetId: string }>()
  const navigate = useNavigate()
  const cache = useQueryClient()
  const query = useTaskSet(taskSetId)
  const processors = useTaskSetProcessors()
  const action = useTaskSetAction(taskSetId)
  const update = useUpdateTaskSet(taskSetId)
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const itemId = params.get('item') ?? undefined
  const rows = usePagedList<TaskSetItemRecord>({
    enabled: Boolean(query.data), path: `/api/task-sets/${taskSetId}/items`,
    queryKey: taskSetKeys.items(taskSetId), scope: taskSetId,
  })
  const set = query.data
  // One detail poll owns progress. Item pages refresh only when that read changes.
  useEffect(() => {
    void cache.invalidateQueries({ queryKey: taskSetKeys.items(taskSetId) })
    if (itemId) void cache.invalidateQueries({ queryKey: taskSetKeys.item(taskSetId, itemId) })
  }, [cache, itemId, set?.completedItems, set?.currentItemId, set?.statusChangedAt, taskSetId])
  const selectItem = (id?: string) => setParams((current) => {
    const next = new URLSearchParams(current)
    if (id) next.set('item', id)
    else next.delete('item')
    return next
  }, { replace: true })
  const editable = Boolean(set && ['draft', 'ready', 'paused', 'blocked'].includes(set.status)
    && !(set.status === 'paused' && set.currentItemId))
  const actions: PageHeaderAction[] = []
  const addAction = (value: TaskSetAction['action'], label: string, primary = false) => actions.push({
    id: value, label, primary, priority: primary ? 100 : 70, disabled: action.isPending,
    onSelect: () => action.mutate({ action: value }),
  })
  if (set?.status === 'draft' || set?.status === 'ready') addAction('start', 'Start processing', true)
  if (set?.status === 'paused' || set?.status === 'blocked') addAction('resume', 'Resume task set', true)
  if (set?.status === 'completed' && set.deliveryStatus === 'blocked') addAction('retry', 'Retry delivery', true)
  if (set && ['running', 'waiting', 'importing'].includes(set.status)) addAction('pause', 'Pause task set')
  if (set && !['completed', 'cancelled'].includes(set.status)) addAction('cancel', 'Cancel task set')
  if (set?.status === 'draft' && !set.source) actions.push({
    id: 'add-item', label: 'Add item', priority: 80, onSelect: () => setAdding(true),
  })
  actions.push({ id: 'refresh', label: 'Refresh', priority: 30,
    onSelect: () => {
      void cache.invalidateQueries({ queryKey: taskSetKeys.all })
      void cache.invalidateQueries({ queryKey: localInferenceKeys.all })
    } })
  const processor = processors.data?.find((candidate) =>
    candidate.localInferenceBindingId && candidate.localInferenceBindingId === set?.processor.localInferenceBindingId,
  )
  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader actions={actions} backLabel="Task Sets" onBack={() => navigate('/agents/task-sets')}
        title={set?.name ?? 'Task set'} />
      <PageBody className="grid gap-6">
        <QueryState errorLabel="This task set could not be loaded." loadingLabel="Loading task set…" query={query}>
          {() => set ? <>
            <Section title={<span className="flex flex-wrap items-center gap-3"><TaskSetStatus status={set.status} />{taskSetProgress(set)}</span>}>
              <div className="grid gap-3 text-sm">
                <p>{set.objective}</p>
                {set.status === 'paused' && set.currentItemId ? <p className="text-[color:var(--tx2)]">
                  Waiting for the current item to stop. Configuration becomes editable once it has stopped.
                </p> : null}
                <p className="text-[color:var(--tx3)]">Status updated {taskSetTimestamp(set.statusChangedAt)}
                  {set.skippedItems ? ` · ${set.skippedItems} skipped` : ''}</p>
                {set.reason ? <FormError>{taskSetReason(set.reason)}</FormError> : null}
                <FormError>{action.error ? formErrorMessage(action.error, 'The task set could not be updated.') : null}</FormError>
                {set.currentItemId ? <button className="admin-button admin-button-secondary justify-self-start"
                  onClick={() => selectItem(set.currentItemId ?? undefined)} type="button">Open current item</button> : null}
                <div className="flex flex-wrap gap-4">
                  {set.source ? <Link className="text-[color:var(--accent)] underline" to={taskSetDocumentPath(set.source.pageId)}>Open input file</Link> : null}
                  {set.outputPageId ? <Link className="text-[color:var(--accent)] underline" to={taskSetDocumentPath(set.outputPageId)}>Open saved output</Link> : null}
                  {set.receiver ? <Link className="text-[color:var(--accent)] underline" to={`/channels/${set.receiver.channelId}`}>Open receiver conversation</Link> : null}
                </div>
                {set.receiver ? <p className="text-[color:var(--tx2)]">Receiver delivery: {set.deliveryStatus}</p> : null}
              </div>
            </Section>
            <Section title={`Processor · ${set.processor.model}`}>
              <p className="text-sm text-[color:var(--tx2)]">One item at a time, in the order below.</p>
              {processor?.localInferenceHostId ? <LocalInferenceHostStatus
                empty={<p className="text-sm">The local processor is unavailable. Review its setup before resuming.</p>}
                hostId={processor.localInferenceHostId} /> : null}
            </Section>
            <Section title="Items">
              <QueryState errorLabel="Items could not be loaded." loadingLabel="Loading items…" query={rows.query}>
                {() => <>
                  <DataTable columns={[
                    { key: 'sequence', header: 'Item', render: (item) => item.sequence },
                    { key: 'prompt', header: 'Work', render: (item) => <div className="max-w-md">
                      <p className="truncate">{item.prompt || item.sourceLocator || 'Source record'}</p>
                      {item.sourceLocator ? <p className="text-xs text-[color:var(--tx3)]">{item.sourceLocator}</p> : null}
                    </div> },
                    { key: 'status', header: 'Status', render: (item) => <TaskSetStatus status={item.status} /> },
                    { key: 'updated', header: 'Status updated', render: (item) => taskSetTimestamp(item.statusChangedAt) },
                  ]} empty="No items yet. Add the first item before starting." expandable={false} label="Task set items"
                    onRowClick={(item) => selectItem(item.id)} rowActionLabel={(item) => `Open item ${item.sequence}`}
                    rowKey={(item) => item.id} rows={rows.items} />
                  <PaginationFooter {...rows} />
                </>}
              </QueryState>
            </Section>
            <details>
              <summary className="cursor-pointer font-semibold">{editable ? 'Edit task set' : 'Configuration'}</summary>
              <div className="pt-5">
                {editable ? <TaskSetForm identity={set.id} sourceLocked={set.totalItems > 0 || set.status !== 'draft'} initial={{
                  name: set.name, objective: set.objective, instructions: set.instructions,
                  processor: set.processor, source: set.source, output: set.output, receiver: set.receiver,
                  search: set.search, maxAttempts: set.maxAttempts, maxParallelRequests: 1,
                } satisfies TaskSetCreate} onSave={(input) => {
                  const changed = Object.fromEntries(Object.entries(input).filter(([key, value]) =>
                    JSON.stringify(value) !== JSON.stringify(set[key as keyof typeof set]),
                  )) as TaskSetUpdate
                  return update.mutateAsync(changed)
                }} onSaved={() => void query.refetch()} submitLabel="Save configuration" />
                  : <p className="whitespace-pre-wrap text-sm">{set.instructions || 'No shared instructions.'}</p>}
              </div>
            </details>
          </> : null}
        </QueryState>
      </PageBody>
      <Dialog onClose={() => setAdding(false)} open={adding} size="lg" title="Add item">
        <TaskSetItemEditor onSaved={() => setAdding(false)} setId={taskSetId} />
      </Dialog>
      <Dialog onClose={() => selectItem()} open={Boolean(itemId)} size="lg" title="Task set item">
        {itemId ? <TaskSetItemDetail editable={editable} itemId={itemId} setId={taskSetId} /> : null}
      </Dialog>
    </section>
  )
}
