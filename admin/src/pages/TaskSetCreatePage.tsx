import { useNavigate, useSearchParams } from 'react-router-dom'
import type { TaskSetCreate } from '@nessie/schemas'
import { useCreateTaskSet } from '../facades/task-sets/hooks'
import { TaskSetForm } from '../components/features/task-sets/TaskSetForm'
import { PageBody } from '../components/shared/PageBody'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { taskSetPath, taskSetSourceFormat } from '../navigation/task-sets'

export const TaskSetCreatePage = () => {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const create = useCreateTaskSet()
  const pageId = params.get('sourcePageId')
  const versionId = params.get('sourceVersionId')
  const format = taskSetSourceFormat(`source.${params.get('format') ?? 'csv'}`) ?? 'csv'
  const initial: TaskSetCreate = {
    name: '', objective: '', instructions: '', processor: { provider: '', model: '' },
    source: pageId && versionId ? { kind: 'document', pageId, versionId, format, selection: {} } : null,
    output: { kind: 'journal' }, receiver: null, maxParallelRequests: 1, maxAttempts: 3, search: 'none',
  }
  return (
    <section className="flex h-full min-h-0 flex-col">
      <ScreenHeader title="New task set" />
      <PageBody>
        <TaskSetForm identity={`new:${pageId ?? 'manual'}:${versionId ?? ''}`} initial={initial}
          onSave={create.mutateAsync} onSaved={(set) => navigate(taskSetPath(set.id), { replace: true })}
          submitLabel="Create task set" />
      </PageBody>
    </section>
  )
}
