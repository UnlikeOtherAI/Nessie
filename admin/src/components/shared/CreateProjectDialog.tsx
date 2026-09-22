import { useRef, useState, type FormEvent } from 'react'
import { useCreateProject } from '../../facades/projects/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { Dialog } from './Dialog'

type CreateProjectDialogProps = {
  onClose: () => void
  open: boolean
}

export const CreateProjectDialog = ({ onClose, open }: CreateProjectDialogProps) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const createProject = useCreateProject()
  // A project is created in the team the person is working in — the session's
  // active team — never one picked from a list. Placing it elsewhere is a team
  // switch first, the same as every other team-scoped action.
  const { me } = useAuthSession()
  const teamId = me?.context.teamId ?? null
  const [name, setName] = useState('')
  // `public` by default, and the same default the server applies when the field
  // is absent — so a project made by the Agent Designer's `project_create` tool
  // lands in the same place as one made here.
  const [visibility, setVisibility] = useState<'protected' | 'public'>('public')
  const [formError, setFormError] = useState<string | null>(null)

  const handleClose = () => {
    setName('')
    setVisibility('public')
    setFormError(null)
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || !teamId) return

    setFormError(null)
    try {
      await createProject.mutateAsync({ name: trimmedName, teamId, visibility })
    } catch (error) {
      // The server is the authority on placement; its refusal belongs on the
      // form rather than in a rejected promise nobody sees.
      setFormError(error instanceof Error ? error.message : 'Unable to create the project.')
      return
    }
    handleClose()
  }

  return (
    <Dialog
      initialFocusRef={nameInputRef}
      onClose={handleClose}
      open={open}
      title="Create a project"
    >
      <form className="grid gap-4" onSubmit={handleSubmit}>
        <div className="grid gap-1.5">
          <label
            className={[
              'text-xs font-semibold uppercase',
              'tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
            htmlFor="project-name"
          >
            Name
          </label>
          <input
            ref={nameInputRef}
            autoComplete="off"
            className="admin-input"
            id="project-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. product-launch"
            value={name}
          />
        </div>
        <div className="grid gap-1.5">
          <label
            className={[
              'text-xs font-semibold uppercase',
              'tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
            htmlFor="project-visibility"
          >
            Visibility
          </label>
          <select
            className="admin-input"
            id="project-visibility"
            onChange={(event) => setVisibility(event.target.value as typeof visibility)}
            value={visibility}
          >
            <option value="public">Public</option>
            <option value="protected">Protected</option>
          </select>
          <p className="text-xs text-[color:var(--tx3)]">
            {visibility === 'public'
              ? 'Anyone in the organisation can find this project and open it.'
              : 'Shown with a lock. People outside it see only its name and who is in it, and are added by someone already here.'}
          </p>
        </div>

        {formError ? (
          <div className="text-xs text-[color:var(--danger-text)]" role="alert">
            {formError}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <button className="admin-button admin-button-secondary" onClick={handleClose} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!name.trim() || !teamId || createProject.isPending}
            type="submit"
          >
            Create project
          </button>
        </div>
      </form>
    </Dialog>
  )
}
