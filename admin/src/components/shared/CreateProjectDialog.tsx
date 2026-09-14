import { useRef, useState, type FormEvent } from 'react'
import { useIsOrganizationAdmin } from '../../facades/auth/hooks'
import { useCreateProject, useTeams } from '../../facades/projects/hooks'
import type { TeamRecord } from '../../lib/api-client'
import { Dialog } from './Dialog'

/**
 * The teams a person can create a project in — the placement
 * `createProjectForUser` enforces: a team they are a member of, or any team for
 * an organisation owner or admin. Offering the others only invites a refusal.
 */
export const teamsForProjectCreation = (
  teams: readonly TeamRecord[],
  isOrganizationAdmin: boolean,
): TeamRecord[] =>
  isOrganizationAdmin ? [...teams] : teams.filter((team) => team.viewerIsMember === true)

type CreateProjectDialogProps = {
  onClose: () => void
  open: boolean
}

export const CreateProjectDialog = ({ onClose, open }: CreateProjectDialogProps) => {
  const nameInputRef = useRef<HTMLInputElement>(null)
  const createProject = useCreateProject()
  const teams = useTeams()
  const isOrganizationAdmin = useIsOrganizationAdmin()
  const creatableTeams = teamsForProjectCreation(teams.data ?? [], isOrganizationAdmin)
  const [name, setName] = useState('')
  const [teamId, setTeamId] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const handleClose = () => {
    setName('')
    setTeamId('')
    setFormError(null)
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return

    setFormError(null)
    try {
      await createProject.mutateAsync({ name: trimmedName, teamId })
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
          <label className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]" htmlFor="project-team">
            Team
          </label>
          <select className="admin-input" id="project-team" onChange={(event) => setTeamId(event.target.value)} value={teamId}>
            <option value="">Choose a team</option>
            {creatableTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
          {teams.isSuccess && creatableTeams.length === 0 ? (
            <div className="text-xs text-[color:var(--tx3)]">
              You are not a member of any team yet, so there is nowhere to create a project.
            </div>
          ) : null}
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
