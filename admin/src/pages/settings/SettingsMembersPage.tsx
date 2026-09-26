import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import type { UserRecord } from '../../lib/api-client'
import { UserAvatar } from '../../components/shared/UserAvatar'
import { useIsOwner } from '../../facades/auth/hooks'
import {
  useCreateUser,
  useSetUserDeactivated,
  useUpdateUserRole,
  useUsers,
} from '../../facades/users/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  PausedPrivateAgentsBucket,
  PersonAgents,
  UnassignedAgents,
} from '../../components/features/members/PersonAgents'
import { buildPeopleAgentsTree } from '../../components/features/members/people-agents-tree'
import { useAgents, usePausedPrivateAgentCount } from '../../facades/agents/queries'
import type { AgentRecord } from '../../lib/api-client'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { Pill } from '../../components/primitives/Pill'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { MembersRosterPanel } from '../../components/features/settings/MembersRosterPanel'
import { OrganizationAdministrationGate } from './OrganizationAdministrationGate'
import { toFormErrors } from '../../facades/forms/form-errors'
import { Card } from '../../components/shared/Card'
import { EmptyState } from '../../components/shared/EmptyState'
import { FormActions, FormError, FormSuccess } from '../../components/shared/FormActions'
import { FormField } from '../../components/shared/FormField'
import { Input, Select } from '../../components/shared/FormControls'
import { Section } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'

const ROLE_OPTIONS = [
  { value: 'owner', label: 'members.roles.owner' },
  { value: 'admin', label: 'members.roles.admin' },
  { value: 'member', label: 'members.roles.member' },
  { value: 'viewer', label: 'members.roles.viewer' },
] as const

const MemberRow = ({
  isSelf,
  ownedAgents,
  user,
}: {
  isSelf: boolean
  ownedAgents: AgentRecord[]
  user: UserRecord
}) => {
  const { t } = useTranslation('settings')
  const { token } = useAuthSession()
  const updateRole = useUpdateUserRole()
  const setDeactivated = useSetUserDeactivated()
  const [error, setError] = useState<string | null>(null)
  const deactivated = Boolean(user.deactivatedAt)
  const busy = updateRole.isPending || setDeactivated.isPending

  const changeRole = async (role: string) => {
    setError(null)
    try {
      await updateRole.mutateAsync({ userId: user.id, role })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('members.local.roleChangeFailed'))
    }
  }

  const toggleDeactivated = async () => {
    setError(null)
    try {
      await setDeactivated.mutateAsync({ userId: user.id, deactivated: !deactivated })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('members.local.memberUpdateFailed'))
    }
  }

  return (
    <Card variant="row">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <UserAvatar
            avatarAttachmentId={user.avatarAttachmentId ?? undefined}
            avatarUrl={user.avatarUrl ?? undefined}
            className={deactivated ? 'opacity-60' : undefined}
            displayName={user.displayName}
            size={40}
            token={token}
            userId={user.id}
          />
          <div className="min-w-0">
            <div className="truncate font-semibold text-[color:var(--tx)]">
              {user.displayName}
              {isSelf ? <span className="ml-1 text-[color:var(--tx3)]">({t('members.local.you')})</span> : null}
            </div>
            <div className="mt-1 truncate text-sm text-[color:var(--tx2)]">{user.email}</div>
          </div>
        </div>
        {deactivated ? (
          <Pill className="shrink-0" radius="chip" size="sm" tone="warning" uppercase={false}>
            Deactivated
          </Pill>
        ) : null}
      </div>

      {/* This person's agents — the same nesting the UOA roster row uses. */}
      <PersonAgents agents={ownedAgents} token={token} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Select
          aria-label={t('members.local.roleFor', { name: user.displayName })}
          disabled={busy}
          onChange={(event) => void changeRole(event.target.value)}
          size="compact"
          value={user.role}
        >
          {ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </Select>
        {isSelf ? null : (
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={busy}
            onClick={() => void toggleDeactivated()}
            type="button"
          >
            {t(deactivated ? 'members.details.reactivate' : 'members.details.deactivate')}
          </button>
        )}
      </div>

      <FormError className="mt-2">{error}</FormError>
    </Card>
  )
}

export const SettingsMembersPage = () => {
  const { t } = useTranslation('settings')
  const { me, token } = useAuthSession()
  const isOwner = useIsOwner()
  // On an UnlikeOtherAI session the roster and its invitations are UOA API
  // features: UOA owns membership, and Nessie holds no list to show.
  const isUoaSession = me?.auth.providerType === 'uoa'
  const usersQuery = useUsers(isOwner && !isUoaSession)
  const users = usersQuery.data ?? []
  const createUser = useCreateUser()

  /*
   * A no-IdP install is the authority for its own people, so the same
   * people-and-their-agents tree renders here with local `User` rows as the
   * source instead of the UOA roster. One join, one renderer, two authoritative
   * sources — never a second implementation of the view.
   */
  const agentsQuery = useAgents({ scope: 'all' })
  // The aggregate is an owner-only server surface. Keep that session-derived
  // query here, at the page boundary, so the shared UOA roster section remains
  // presentational and can render without an auth-session provider.
  const pausedPrivateAgentCount = usePausedPrivateAgentCount(isOwner)
  const localTree = (() => {
    const agents = Array.isArray(agentsQuery.data) ? agentsQuery.data : []
    const tree = buildPeopleAgentsTree(
      users.map((user) => ({ displayName: user.displayName, uoaSub: user.id, userId: user.id })),
      agents,
      { pausedPrivateAgentCount: pausedPrivateAgentCount.data?.count ?? 0 },
    )
    return {
      agentsByUserId: new Map(
        tree.people.map((person) => [person.member.userId ?? '', person.agents]),
      ),
      tree,
    }
  })()

  const [userDisplayName, setUserDisplayName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userPassword, setUserPassword] = useState('')
  const [userRole, setUserRole] = useState('member')
  const [addFieldErrors, setAddFieldErrors] = useState<Record<string, string>>({})
  const [addFormError, setAddFormError] = useState<string | undefined>(undefined)
  const [addSuccess, setAddSuccess] = useState(false)

  if (!me) {
    return null
  }

  if (isUoaSession) {
    return (
      <OrganizationAdministrationGate>
        <MembersRosterPanel scope="organization" />
      </OrganizationAdministrationGate>
    )
  }

  // Members management is owner-only; non-owners are routed back to their profile.
  if (!isOwner) {
    return <Navigate to="/settings/account" replace />
  }

  const createUserSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAddFieldErrors({})
    setAddFormError(undefined)
    setAddSuccess(false)
    try {
      await createUser.mutateAsync({
        displayName: userDisplayName,
        email: userEmail,
        password: userPassword,
        role: userRole,
      })
      setUserDisplayName('')
      setUserEmail('')
      setUserPassword('')
      setUserRole('member')
      setAddSuccess(true)
    } catch (error) {
      const { fieldErrors, formError } = toFormErrors(error)
      setAddFieldErrors(fieldErrors)
      setAddFormError(formError ?? (Object.keys(fieldErrors).length === 0 ? t('members.local.addFailed') : undefined))
    }
  }

  const canAddMember =
    !createUser.isPending && userEmail.trim().length > 0 && userPassword.length >= 8

  return (
    <SettingsPanel eyebrow={t('organization.organisation')} title={t('members.title')}>
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title={t('members.local.people')}>
          <QueryState
            errorLabel={t('members.loadFailed')}
            loadingLabel={t('members.loadingMembers')}
            query={usersQuery}
          >
            {() => (
              users.length > 0 ? (
                <div className="grid gap-2">
                  {users.map((user) => (
                    <MemberRow
                      isSelf={user.id === me.user.id}
                      key={user.id}
                      ownedAgents={localTree.agentsByUserId.get(user.id) ?? []}
                      user={user}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState>{t('members.local.noMembers')}</EmptyState>
              )
            )}
          </QueryState>
          {localTree.tree.pausedPrivateAgentCount > 0 || localTree.tree.teamOwned.length > 0 ? (
            <div
              className="border-t border-[color:var(--sep)] pt-4"
              data-testid="local-unassigned-agents"
            >
              <PausedPrivateAgentsBucket count={localTree.tree.pausedPrivateAgentCount} />
              {localTree.tree.teamOwned.length > 0 ? (
                <UnassignedAgents
                  agents={localTree.tree.teamOwned}
                  emptyLabel={t('members.teamPeople.none')}
                  title={t('members.teamPeople.teamOwnedAgents')}
                  token={token}
                />
              ) : null}
            </div>
          ) : null}
        </Section>

        <Card as="section">
          <SectionLabel>{t('members.local.addMember')}</SectionLabel>
          <form className="mt-4 grid gap-3" onSubmit={createUserSubmit}>
            <FormField error={addFieldErrors.displayName} label={t('members.local.displayName')}>
              <Input
                onChange={(event) => setUserDisplayName(event.target.value)}
                placeholder={t('members.local.displayName')}
                value={userDisplayName}
              />
            </FormField>
            <FormField error={addFieldErrors.email} label={t('members.invite.email')}>
              <Input
                onChange={(event) => setUserEmail(event.target.value)}
                placeholder="name@example.com"
                type="email"
                value={userEmail}
              />
            </FormField>
            <FormField error={addFieldErrors.password} help={t('members.local.passwordHelp')} label={t('members.local.password')}>
              <Input
                autoComplete="new-password"
                onChange={(event) => setUserPassword(event.target.value)}
                type="password"
                value={userPassword}
              />
            </FormField>
            <FormField label={t('members.details.role')}>
              <Select
                onChange={(event) => setUserRole(event.target.value)}
                value={userRole}
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.label)}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormError>{addFormError}</FormError>
            <FormSuccess>{addSuccess ? t('members.local.memberAdded') : undefined}</FormSuccess>
            <FormActions>
              <button
                className="admin-button admin-button-primary disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!canAddMember}
                type="submit"
              >
                {createUser.isPending ? t('members.local.adding') : t('members.local.addMember')}
              </button>
            </FormActions>
          </form>
        </Card>
      </div>
    </SettingsPanel>
  )
}
