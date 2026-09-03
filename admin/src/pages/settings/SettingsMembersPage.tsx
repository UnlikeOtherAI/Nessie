import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import type { UserRecord } from '../../lib/api-client'
import { UserAvatar } from '../../components/primitives/UserAvatar'
import { useIsOwner } from '../../components/shared/OwnerGate'
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
import { SettingsPanel } from './settings-shared'
import { Pill } from '../../components/primitives/Pill'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { TeamMembersSection } from './TeamMembersSection'
import { startExternalSignIn } from '../../lib/external-auth'
import { resolveAppliedTheme, useTheme } from '../../providers/ThemeProvider'
import { toFormErrors } from '../../facades/form-errors'
import { Card } from '../../components/shared/Card'
import { EmptyState } from '../../components/shared/EmptyState'
import { FormActions, FormError, FormSuccess } from '../../components/shared/FormActions'
import { FormField } from '../../components/shared/FormField'
import { Input, Select } from '../../components/shared/FormControls'
import { Section } from '../../components/shared/PageBody'
import { QueryState } from '../../components/shared/QueryState'

const ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
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
      setError(caught instanceof Error ? caught.message : 'Failed to update role')
    }
  }

  const toggleDeactivated = async () => {
    setError(null)
    try {
      await setDeactivated.mutateAsync({ userId: user.id, deactivated: !deactivated })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to update member')
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
              {isSelf ? <span className="ml-1 text-[color:var(--tx3)]">(You)</span> : null}
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
          aria-label={`Role for ${user.displayName}`}
          disabled={busy}
          onChange={(event) => void changeRole(event.target.value)}
          size="compact"
          value={user.role}
        >
          {ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
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
            {deactivated ? 'Reactivate' : 'Deactivate'}
          </button>
        )}
      </div>

      <FormError className="mt-2">{error}</FormError>
    </Card>
  )
}

export const SettingsMembersPage = () => {
  const { me, token } = useAuthSession()
  const { theme } = useTheme()
  const roleIds = me?.user.roleIds ?? []
  const isOwner = useIsOwner()
  // On an UnlikeOtherAI session the roster and its invitations are UOA API
  // features: UOA owns membership, and Nessie holds no list to show.
  const isUoaSession = me?.auth.providerType === 'uoa'
  const canManageTeam = isOwner || roleIds.includes('admin')
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
    // The roster is entitlement-scoped the way `GET /api/team/members` is:
    // any active member reads it, and only owners and admins get the controls
    // that mutate it (role, activation, removal, invitations) — the API refuses
    // those for anyone else, so rendering them would only produce 403s.
    return (
      <SettingsPanel eyebrow="Organization" title="Members">
        <TeamMembersSection
          canManage={canManageTeam}
          onReconnect={async () => {
            const providerId = me.auth.providerId
            if (!providerId) throw new Error('UnlikeOtherAI sign-in is not configured.')
            await startExternalSignIn(providerId, resolveAppliedTheme(theme), {
              returnPath: window.location.pathname + window.location.search,
            })
          }}
          pausedPrivateAgentCount={pausedPrivateAgentCount.data?.count ?? 0}
        />
      </SettingsPanel>
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
      setAddFormError(formError ?? (Object.keys(fieldErrors).length === 0 ? 'Failed to add member.' : undefined))
    }
  }

  const canAddMember =
    !createUser.isPending && userEmail.trim().length > 0 && userPassword.length >= 8

  return (
    <SettingsPanel eyebrow="Organization" title="Members">
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="People">
          <QueryState
            errorLabel="Could not load members."
            loadingLabel="Loading members…"
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
                <EmptyState>No members yet.</EmptyState>
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
                  emptyLabel="None"
                  title="Team-owned agents"
                  token={token}
                />
              ) : null}
            </div>
          ) : null}
        </Section>

        <Card as="section">
          <SectionLabel>Add member</SectionLabel>
          <form className="mt-4 grid gap-3" onSubmit={createUserSubmit}>
            <FormField error={addFieldErrors.displayName} label="Display name">
              <Input
                onChange={(event) => setUserDisplayName(event.target.value)}
                placeholder="Display name"
                value={userDisplayName}
              />
            </FormField>
            <FormField error={addFieldErrors.email} label="Email">
              <Input
                onChange={(event) => setUserEmail(event.target.value)}
                placeholder="name@example.com"
                type="email"
                value={userEmail}
              />
            </FormField>
            <FormField error={addFieldErrors.password} help="At least 8 characters." label="Password">
              <Input
                autoComplete="new-password"
                onChange={(event) => setUserPassword(event.target.value)}
                type="password"
                value={userPassword}
              />
            </FormField>
            <FormField label="Role">
              <Select
                onChange={(event) => setUserRole(event.target.value)}
                value={userRole}
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormError>{addFormError}</FormError>
            <FormSuccess>{addSuccess ? 'Member added.' : undefined}</FormSuccess>
            <FormActions>
              <button
                className="admin-button admin-button-primary disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!canAddMember}
                type="submit"
              >
                {createUser.isPending ? 'Adding…' : 'Add member'}
              </button>
            </FormActions>
          </form>
        </Card>
      </div>
    </SettingsPanel>
  )
}
