import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemberRosterPermissions, TeamMemberRecord } from '@nessie/schemas'

import { Checkbox } from '../../primitives/Checkbox'
import { Dialog } from '../../shared/Dialog'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { QueryState } from '../../shared/QueryState'
import { FormActions, FormError } from '../../shared/FormActions'
import { Select } from '../../shared/FormControls'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import {
  useMemberTeamAccess,
  useUpdateOrganizationMemberRole,
  useUpdateMemberTeamAccess,
  useUpdateTeamMemberRole,
  type MemberRosterScope,
} from '../../../facades/users/member-roster'
import { useRemoveTeamMember, useSetTeamMemberActivation } from '../../../facades/users/team-members'
import { memberDisplayName } from '../../../lib/member-display-name'
import { LocalInferenceEnablement } from '../local-inference/LocalInferenceEnablement'
import { Notice } from '../../primitives/Notice'

type MemberDetailsDialogProps = {
  member: TeamMemberRecord | null
  onClose: () => void
  open: boolean
  permissions: MemberRosterPermissions | undefined
  scope: MemberRosterScope
}

const sameIds = (first: string[], second: string[]) =>
  first.length === second.length && first.every((id) => second.includes(id))

const EMPTY_WORKSPACES: never[] = []

/** The one row-detail flow for team role and organisation team access. */
export const MemberDetailsDialog = ({
  member,
  onClose,
  open,
  permissions,
  scope,
}: MemberDetailsDialogProps) => {
  const { t } = useTranslation('settings')
  const roleMutation = useUpdateTeamMemberRole()
  const organizationRoleMutation = useUpdateOrganizationMemberRole()
  const teamMutation = useUpdateMemberTeamAccess()
  const removeMutation = useRemoveTeamMember()
  const activationMutation = useSetTeamMemberActivation()
  const [action, setAction] = useState<'remove' | 'deactivate' | 'reactivate' | null>(null)
  const teamAccess = useMemberTeamAccess(
    member?.uoaSub ?? null,
    open && scope === 'organization' && member !== null,
  )
  const [role, setRole] = useState('')
  const [teamIds, setTeamIds] = useState<string[]>([])
  const [initialTeamIds, setInitialTeamIds] = useState<string[]>([])
  const initializedTeamAccessKey = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const teams = teamAccess.data?.data.items ?? EMPTY_WORKSPACES
  const loadedTeamIds = useMemo(
    () => teams.filter((team) => team.hasAccess).map((team) => team.id),
    [teams],
  )
  const organizationRoleOptions = permissions?.orgRoleOptions
  const roleOptions = useMemo(() => {
    const options = scope === 'team'
      ? permissions?.teamRoleOptions ?? []
      : organizationRoleOptions ?? []
    const currentRole = scope === 'team' ? member?.teamRole : member?.orgRole
    return scope === 'team' && currentRole && !options.includes(currentRole)
      ? [currentRole, ...options]
      : options
  }, [member?.orgRole, member?.teamRole, organizationRoleOptions, permissions?.teamRoleOptions, scope])
  const currentRole = scope === 'team' ? member?.teamRole : member?.orgRole
  const teamAccessKey = open && scope === 'organization' && member
    ? `${member.uoaSub}:${scope}`
    : null
  // Ownership moves through UOA's separate transfer workflow. A member's
  // current owner role is therefore information, never an editable option.
  const canChangeRole = permissions?.changeMemberRole === true
    && (scope === 'team' || member?.orgRole !== 'owner')
    && roleOptions.length > 0
  const canChangeTeams = !teamAccess.isError && teamAccess.data?.data.permissions.changeTeamAccess === true
  const busy = roleMutation.isPending || organizationRoleMutation.isPending || teamMutation.isPending
    || removeMutation.isPending || activationMutation.isPending

  useEffect(() => {
    setError(null)
    setAction(null)
    setRole(scope === 'team' ? member?.teamRole ?? '' : member?.orgRole ?? '')
  }, [member?.orgRole, member?.teamRole, member?.uoaSub, open, scope])

  useEffect(() => {
    setInitialTeamIds([])
    initializedTeamAccessKey.current = null
    setTeamIds([])
  }, [teamAccessKey])

  useEffect(() => {
    if (!teamAccessKey || !teamAccess.isSuccess || initializedTeamAccessKey.current === teamAccessKey) return
    initializedTeamAccessKey.current = teamAccessKey
    setInitialTeamIds(loadedTeamIds)
    setTeamIds(loadedTeamIds)
  }, [loadedTeamIds, teamAccess.isSuccess, teamAccessKey])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!member) return
    setError(null)
    try {
      if (role !== currentRole && canChangeRole) {
        const mutation = scope === 'team' ? roleMutation : organizationRoleMutation
        await mutation.mutateAsync({ role, uoaSub: member.uoaSub })
      }
      if (scope === 'organization' && !sameIds(teamIds, initialTeamIds)) {
        await teamMutation.mutateAsync({ uoaSub: member.uoaSub, teamIds })
      }
      onClose()
    } catch (caught) {
      setError(formErrorMessage(caught, t('members.details.saveFailed')))
    }
  }

  const toggleTeam = (teamId: string, checked: boolean) => {
    setTeamIds((current) => checked
      ? [...current, teamId]
      : current.filter((id) => id !== teamId))
  }

  const name = memberDisplayName(member?.displayName, member?.email) ?? t('members.member')
  const actionLabel = action === 'remove' ? t('members.details.removeFromTeam')
    : action === 'deactivate' ? t('members.details.deactivate') : t('members.details.reactivate')
  const actionTitle = action === 'remove' ? t('members.details.removeTitle', { name })
    : action === 'deactivate' ? t('members.details.deactivateTitle', { name }) : t('members.details.reactivateTitle', { name })
  const changeMembership = async () => {
    if (!member || !action) return
    setError(null)
    try {
      if (action === 'remove') await removeMutation.mutateAsync({ uoaSub: member.uoaSub })
      else await activationMutation.mutateAsync({ uoaSub: member.uoaSub, deactivated: action === 'deactivate' })
      setAction(null)
      onClose()
    } catch (caught) {
      setError(formErrorMessage(caught, t('members.details.actionFailed')))
    }
  }
  const hasRoleChange = role !== (currentRole ?? '')
  const hasChanges = scope === 'team'
    ? hasRoleChange
    : hasRoleChange || !sameIds(teamIds, initialTeamIds)

  return (
    <>
    <Dialog
      description={t(scope === 'team' ? 'members.details.teamDescription' : 'members.details.organizationDescription')}
      dismissDisabled={busy}
      onClose={onClose}
      open={open && member !== null}
      title={name}
    >
      <form className="space-y-4 p-4" onSubmit={(event) => void submit(event)}>
        {scope === 'team' || member?.orgRole !== 'owner' ? (
          <div className="space-y-2">
            <label className="block text-sm font-medium text-[color:var(--tx)]" htmlFor="member-role">
              {t(scope === 'team' ? 'members.details.role' : 'members.details.organizationRole')}
            </label>
            <Select
              disabled={!canChangeRole || busy}
              id="member-role"
              onChange={(event) => setRole(event.target.value)}
              value={role}
            >
              {roleOptions.map((option) => <option key={option} value={option}>{t(`members.roles.${option}`)}</option>)}
            </Select>
            {!canChangeRole ? (
              <p className="text-xs text-[color:var(--tx3)]">
                {t(permissions?.changeMemberRole === true
                  ? 'members.details.noOtherRoles'
                  : 'members.details.rolePermissionDenied')}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-[color:var(--tx3)]">
            {t('members.details.ownsOrganization')}
          </p>
        )}
        {scope === 'organization' ? (
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium text-[color:var(--tx)]">{t('members.details.teamAccess')}</p>
              <p className="text-xs text-[color:var(--tx3)]">{t('members.details.managedTeamsOnly')}</p>
            </div>
            <QueryState
              className="py-2"
              emptyLabel={t('members.details.noManagedTeams')}
              errorLabel={t('members.details.teamAccessLoadFailed')}
              isEmpty={teams.length === 0}
              loadingLabel={t('members.details.loadingTeams')}
              query={teamAccess}
            >
            {() => <div className="grid max-h-64 gap-1 overflow-y-auto">
              {teams.map((team) => (
                <div className="rounded px-1.5 py-1 hover:bg-[color:var(--overlay)]" key={team.id}>
                  <Checkbox
                    checked={teamIds.includes(team.id)}
                    disabled={!canChangeTeams || busy}
                    label={team.name}
                    onChange={(checked) => toggleTeam(team.id, checked)}
                  />
                </div>
              ))}
            </div>}
            </QueryState>
            {!teamAccess.isLoading && !canChangeTeams && teams.length > 0 ? (
              <p className="text-xs text-[color:var(--tx3)]">{t('members.details.teamPermissionDenied')}</p>
            ) : null}
          </div>
        ) : null}

        {scope === 'organization' ? (
          member?.userId ? (
            <LocalInferenceEnablement scope="user" userId={member.userId} />
          ) : (
            <Notice tone="neutral">
              {t('members.details.localOllamaHint')}
            </Notice>
          )
        ) : null}

        <FormError>{error}</FormError>
        {scope === 'team' ? (
          <div className="flex flex-wrap gap-2">
            {permissions?.removeMember === true ? (
              <button className="admin-button admin-button-danger" disabled={busy}
                onClick={() => { setError(null); setAction('remove') }} type="button">
                {t('members.details.removeFromTeam')}
              </button>
            ) : null}
            {(member?.status === 'DEACTIVATED' ? permissions?.reactivateMember : permissions?.deactivateMember) === true ? (
              <button className="admin-button admin-button-secondary" disabled={busy}
                onClick={() => { setError(null); setAction(member?.status === 'DEACTIVATED' ? 'reactivate' : 'deactivate') }}
                type="button">
                {t(member?.status === 'DEACTIVATED' ? 'members.details.reactivateInOrganization' : 'members.details.deactivateInOrganization')}
              </button>
            ) : null}
          </div>
        ) : null}
        <FormActions>
          <button className="admin-button admin-button-secondary" disabled={busy} onClick={onClose} type="button">
            {t('common.cancel')}
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={busy || !hasChanges || (hasRoleChange && !canChangeRole)
              || (scope === 'organization' && !sameIds(teamIds, initialTeamIds) && !canChangeTeams)}
            type="submit"
          >
            {busy ? t('common.saving') : t('members.details.saveChanges')}
          </button>
        </FormActions>
      </form>
    </Dialog>
    <ConfirmDialog
      blocking
      body={<>
        <p>{t(action === 'remove' ? 'members.details.removeBody'
          : action === 'deactivate' ? 'members.details.deactivateBody' : 'members.details.reactivateBody')}</p>
        <FormError>{error}</FormError>
      </>}
      confirmLabel={actionLabel}
      destructive={action !== 'reactivate'}
      onCancel={() => { setAction(null); setError(null) }}
      onConfirm={() => void changeMembership()}
      open={open && action !== null}
      pending={busy}
      title={actionTitle}
    />
    </>
  )
}
