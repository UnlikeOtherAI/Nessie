import { taskSetPath } from '../../../navigation/task-sets'
import { Link } from 'react-router-dom'
import { useTaskSetAction, useTaskSetItem } from '../../../facades/task-sets/hooks'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import { FormError } from '../../shared/FormActions'
import { QueryState } from '../../shared/QueryState'
import { TaskSetItemEditor } from './TaskSetItemEditor'
import { TaskSetStatus, taskSetDocumentPath, taskSetTimestamp } from './presentation'

export const TaskSetItemDetail = ({ setId, itemId, editable }: {
  setId: string
  itemId: string
  editable: boolean
}) => {
  const query = useTaskSetItem(setId, itemId)
  const action = useTaskSetAction(setId)
  return <QueryState errorLabel="This item could not be loaded." loadingLabel="Loading item…" query={query}>
    {() => {
      const item = query.data
      if (!item) return null
      return <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TaskSetStatus status={item.status} />
          <span className="text-xs text-[color:var(--tx3)]">Updated {taskSetTimestamp(item.statusChangedAt)} · {item.attempts} attempts</span>
        </div>
        {item.sourceLocator ? <p className="text-sm text-[color:var(--tx2)]">{item.sourceLocator}</p> : null}
        {item.reason ? <FormError>{item.reason}</FormError> : null}
        <p className="whitespace-pre-wrap text-sm">{item.prompt}</p>
        {item.input != null ? <section className="grid gap-2">
          <h3 className="font-semibold">Input</h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
            {typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2)}
          </pre>
        </section> : null}
        {item.dependencies.length ? <section className="grid gap-2">
          <h3 className="font-semibold">Prerequisites</h3>
          {item.dependencies.map((id, index) => <Link className="text-sm text-[color:var(--accent)] underline"
            key={id} to={`${taskSetPath(setId)}?item=${encodeURIComponent(id)}`}>
            Open prerequisite {index + 1}
          </Link>)}
        </section> : null}
        {item.result !== null ? <section className="grid gap-2">
          <h3 className="font-semibold">Result</h3>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{item.result}</pre>
        </section> : null}
        {item.outputPageId ? <Link className="text-sm text-[color:var(--accent)] underline" to={taskSetDocumentPath(item.outputPageId)}>
          Open saved result
        </Link> : null}
        {editable && ['failed', 'blocked_dependency'].includes(item.status) ? <div className="flex flex-wrap gap-2">
          <button className="admin-button admin-button-primary" disabled={action.isPending}
            onClick={() => action.mutate({ action: 'retry', itemId })} type="button">Retry item</button>
          <button className="admin-button admin-button-secondary" disabled={action.isPending}
            onClick={() => action.mutate({ action: 'skip', itemId })} type="button">Skip item</button>
        </div> : null}
        <FormError>{action.error ? formErrorMessage(action.error, 'The item could not be updated.') : null}</FormError>
        {editable && ['pending', 'failed', 'blocked_dependency'].includes(item.status) ? <details>
          <summary className="cursor-pointer text-sm font-semibold">Edit instructions, input or prerequisites</summary>
          <div className="pt-4"><TaskSetItemEditor item={item} onSaved={() => void query.refetch()} setId={setId} /></div>
        </details> : null}
      </div>
    }}
  </QueryState>
}
