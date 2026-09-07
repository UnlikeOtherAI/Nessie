import type { TaskRecord } from '../../../../facades/tasks/hooks'
import { FormActions } from '../../../shared/FormActions'
import { statusLabel } from './kanban-config'

type TaskDialogActionsProps = {
  archived: boolean
  canSubmit: boolean
  onCancel: () => void
  onClose: () => void
  onRestore: () => void
  onUnarchive: () => void
  task: TaskRecord | null | undefined
}

/** The task dialog's save, close and lifecycle actions share one stable footer. */
export const TaskDialogActions = ({
  archived,
  canSubmit,
  onCancel,
  onClose,
  onRestore,
  onUnarchive,
  task,
}: TaskDialogActionsProps) => (
  <FormActions
    className="md:col-span-2"
    destructive={
      task ? (
        task.archivedAt ? (
          <button
            className="text-xs font-semibold text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
            onClick={onUnarchive}
            type="button"
          >
            Unarchive
          </button>
        ) : archived ? (
          <button
            className="text-xs font-semibold text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
            onClick={onRestore}
            type="button"
          >
            Restore ({statusLabel(task.status)})
          </button>
        ) : (
          <button
            className="text-xs font-semibold text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
            onClick={onCancel}
            type="button"
          >
            Cancel task
          </button>
        )
      ) : null
    }
  >
    <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
      Close
    </button>
    <button className="admin-button admin-button-primary" disabled={!canSubmit} type="submit">
      {task ? 'Save changes' : 'Create task'}
    </button>
  </FormActions>
)
