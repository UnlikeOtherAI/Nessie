import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { MemberRosterPermissions, TeamMemberRecord } from '@nessie/schemas'

import { Checkbox } from '../../components/primitives/Checkbox'
import { Dialog } from '../../components/shared/Dialog'
import { FormActions, FormError } from '../../components/shared/FormActions'
import { Select } from '../../components/shared/FormControls'
import {
  useMemberWorkspaceAccess,
  useUpdateMemberWorkspaceAccess,
  useUpdateTeamMemberRole,
  type MemberRosterScope,
} from '../../facades/users/member-roster'

type MemberDetailsDialogProps = {
  member: TeamMemberRecord | null
  onClose: () => void
  open: boolean
  permissions: MemberRosterPermissions | undefined
  scope: MemberRosterScope
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Unable to save member access.'

const sameIds = (first: string[], second: string[]) =>
  first.length === second.length && first.every((id) => second.includes(id))

const EMPTY_WORKSPACES: never[] = []

/** The one row-detail flow for team role and organisation workspace access. */
export const MemberDetailsDialog = ({
  member,
  onClose,
  open,
  permissions,
  scope,
}: MemberDetailsDialogProps) => {
  const roleMutation = useUpdateTeamMemberRole()
  const workspaceMutation = useUpdateMemberWorkspaceAccess()
  const workspaceAccess = useMemberWorkspaceAccess(
    member?.uoaSub ?? null,
    open && scope === 'organization' && member !== null,
  )
  const [role, setRole] = useState('')
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const workspaces = workspaceAccess.data?.data.items ?? EMPTY_WORKSPACES
  const initialWorkspaceIds = useMemo(
    () => workspaces.filter((workspace) => workspace.hasAccess).map((workspace) => workspace.id),
    [workspaces],
  )
  const roleOptions = useMemo(() => {
    const options = permissions?.teamRoleOptions ?? []
    return member?.teamRole && !options.includes(member.teamRole)
      ? [member.teamRole, ...options]
      : options
  }, [member?.teamRole, permissions?.teamRoleOptions])
  const canChangeRole = permissions?.changeMemberRole === true && roleOptions.length > 0
  const canChangeWorkspaces = workspaceAccess.data?.data.permissions.changeWorkspaceAccess === true
  const busy = roleMutation.isPending || workspaceMutation.isPending

  useEffect(() => {
    setError(null)
    setRole(member?.teamRole ?? '')
  }, [member?.teamRole, member?.uoaSub])

  useEffect(() => {
    setWorkspaceIds(initialWorkspaceIds)
  }, [initialWorkspaceIds])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!member) return
    setError(null)
    try {
      if (scope === 'team') {
        await roleMutation.mutateAsync({ role, uoaSub: member.uoaSub })
      } else {
        await workspaceMutation.mutateAsync({ uoaSub: member.uoaSub, workspaceIds })
      }
      onClose()
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const toggleWorkspace = (workspaceId: string, checked: boolean) => {
    setWorkspaceIds((current) => checked
      ? [...current, workspaceId]
      : current.filter((id) => id !== workspaceId))
  }

  const name = member?.displayName ?? member?.email ?? 'Member'
  const hasChanges = scope === 'team'
    ? role !== (member?.teamRole ?? '')
    : !sameIds(workspaceIds, initialWorkspaceIds)

  return (
    <Dialog
      description={scope === 'team'
        ? 'Change this member’s role in the current workspace.'
        : 'Select the workspaces this member can access.'}
      dismissDisabled={busy}
      onClose={onClose}
      open={open && member !== null}
      title={name}
    >
      <form className="space-y-4 p-4" onSubmit={(event) => void submit(event)}>
        {scope === 'team' ? (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[color:var(--tx)]" htmlFor="member-role">
              Role
            </label>
            <Select
              disabled={!canChangeRole || busy}
              id="member-role"
              onChange={(event) => setRole(event.target.value)}
              value={role}
            >
              {roleOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </Select>
            {!canChangeRole ? (
              <p className="text-xs text-[color:var(--tx3)]">You don’t have permission to change this role.</p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium text-[color:var(--tx)]">Workspace access</p>
              <p className="text-xs text-[color:var(--tx3)]">Only workspaces you can manage are shown.</p>
            </div>
            {workspaceAccess.isLoading ? <p className="text-sm text-[color:var(--tx3)]">Loading workspaces…</p> : null}
            {!workspaceAccess.isLoading && workspaces.length === 0 ? (
              <p className="text-sm text-[color:var(--tx3)]">No editable workspace access is available.</p>
            ) : null}
            <div className="grid max-h-64 gap-1 overflow-y-auto rounded-lg border border-[color:var(--sep)] p-2">
              {workspaces.map((workspace) => (
                <div className="rounded px-1.5 py-1 hover:bg-[color:var(--overlay)]" key={workspace.id}>
                  <Checkbox
                    checked={workspaceIds.includes(workspace.id)}
                    disabled={!canChangeWorkspaces || busy}
                    label={workspace.name}
                    onChange={(checked) => toggleWorkspace(workspace.id, checked)}
                  />
                </div>
              ))}
            </div>
            {!workspaceAccess.isLoading && !canChangeWorkspaces && workspaces.length > 0 ? (
              <p className="text-xs text-[color:var(--tx3)]">You don’t have permission to change this access.</p>
            ) : null}
          </div>
        )}

        <FormError>{error}</FormError>
        <FormActions>
          <button className="admin-button admin-button-secondary" disabled={busy} onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={busy || !hasChanges || (scope === 'team' ? !canChangeRole : !canChangeWorkspaces)}
            type="submit"
          >
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
