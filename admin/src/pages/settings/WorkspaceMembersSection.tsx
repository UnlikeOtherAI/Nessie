import { useState, type FormEvent } from 'react'
import type { WorkspaceInvitationRecord, WorkspaceMemberRecord } from '@nessie/schemas'
import { UserAvatar } from '../../components/primitives/UserAvatar'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  useCreateWorkspaceInvitations,
  useRemoveWorkspaceMember,
  useResendWorkspaceInvitation,
  useReviewWorkspaceInvitation,
  useRevokeWorkspaceInvitation,
  useSetWorkspaceMemberActivation,
  useUpdateWorkspaceMemberRole,
  useWorkspaceInvitations,
  useWorkspaceMembers,
} from '../../facades/users/workspace-members'
import { FeedbackBanner, type SettingsFeedback } from './settings-shared'
import { Pill } from '../../components/primitives/Pill'
import { SectionLabel } from '../../components/primitives/SectionLabel'

/**
 * The workspace roster on an UnlikeOtherAI session: people, their workspace
 * role, and the invitations that are still in flight — all read live from UOA,
 * none of it stored by Nessie. Invitation acceptance is hosted by UOA, so there
 * is no accept flow here, and there is no "add member with a password" form:
 * an invitation is how somebody joins.
 */

// UOA's own team-role vocabulary. Ownership transfer is a separate UOA
// operation, so "owner" is shown but never offered as a change.
const TEAM_ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
] as const

const errorMessage = (caught: unknown, fallback: string): string =>
  caught instanceof Error ? caught.message : fallback

const memberLabel = (member: WorkspaceMemberRecord): string =>
  member.displayName ?? member.email ?? member.uoaSub

const MemberRow = ({
  canManage,
  member,
}: {
  canManage: boolean
  member: WorkspaceMemberRecord
}) => {
  const { token } = useAuthSession()
  const updateRole = useUpdateWorkspaceMemberRole()
  const removeMember = useRemoveWorkspaceMember()
  const setActivation = useSetWorkspaceMemberActivation()
  const [error, setError] = useState<string | null>(null)

  const deactivated = member.status === 'DEACTIVATED'
  const busy = updateRole.isPending || removeMember.isPending || setActivation.isPending
  const label = memberLabel(member)

  const act = async (run: () => Promise<unknown>, fallback: string) => {
    setError(null)
    try {
      await run()
    } catch (caught) {
      setError(errorMessage(caught, fallback))
    }
  }

  return (
    <div className="admin-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {/*
            A roster row is named only by its UOA subject, so the picture comes
            from the subject-keyed relay rather than the user-id one. The same
            `UserAvatar` as everywhere else: it falls back to initials for an
            unlinked person, an unlinked workspace, or a deployment with no UOA.
          */}
          <UserAvatar
            className={deactivated ? 'opacity-60' : undefined}
            displayName={label}
            size={40}
            token={token}
            uoaSub={member.uoaSub}
          />
          <div className="min-w-0">
            <div className="truncate font-semibold text-[color:var(--tx)]">{label}</div>
            {member.email ? (
              <div className="mt-1 truncate text-sm text-[color:var(--tx2)]">{member.email}</div>
            ) : null}
          </div>
        </div>
        {deactivated ? (
          <Pill className="shrink-0" radius="chip" size="sm" tone="warning">Deactivated</Pill>
        ) : null}
        {/* Not a `Pill`: this chip's fill is --main-hover, an opaque surface token
            equal to --panel on six of ten themes, so on this card it reads as no
            fill at all. `Pill`'s muted tone paints the translucent --overlay-weak,
            which does show. */}
        {member.teamRole === 'owner' ? (
          <span className="shrink-0 rounded bg-[color:var(--main-hover)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-[color:var(--tx3)]">
            Owner
          </span>
        ) : null}
      </div>

      {canManage && member.teamRole !== 'owner' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            aria-label={`Workspace role for ${label}`}
            className="admin-input admin-input-compact"
            disabled={busy}
            onChange={(event) =>
              void act(
                () => updateRole.mutateAsync({ role: event.target.value, uoaSub: member.uoaSub }),
                'Failed to update role',
              )}
            value={member.teamRole ?? 'member'}
          >
            {TEAM_ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={busy}
            onClick={() =>
              void act(
                () =>
                  setActivation.mutateAsync({ deactivated: !deactivated, uoaSub: member.uoaSub }),
                'Failed to update member',
              )}
            type="button"
          >
            {deactivated ? 'Reactivate' : 'Deactivate'}
          </button>
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={busy}
            onClick={() =>
              void act(
                () => removeMember.mutateAsync({ uoaSub: member.uoaSub }),
                'Failed to remove member',
              )}
            type="button"
          >
            Remove from workspace
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="mt-2 text-xs text-[color:var(--danger-text)]" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

const InvitationRow = ({ invitation }: { invitation: WorkspaceInvitationRecord }) => {
  const resend = useResendWorkspaceInvitation()
  const review = useReviewWorkspaceInvitation()
  const revoke = useRevokeWorkspaceInvitation()
  const [error, setError] = useState<string | null>(null)

  const awaitingApproval = invitation.approvalStatus === 'pending'
  const busy = resend.isPending || review.isPending || revoke.isPending

  const act = async (run: () => Promise<unknown>, fallback: string) => {
    setError(null)
    try {
      await run()
    } catch (caught) {
      setError(errorMessage(caught, fallback))
    }
  }

  return (
    <div className="admin-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold text-[color:var(--tx)]">
            {invitation.email ?? invitation.name ?? invitation.inviteId}
          </div>
          <div className="mt-1 truncate text-sm text-[color:var(--tx2)]">
            {[
              invitation.status ?? 'pending',
              invitation.teamRole,
              invitation.invitedByName ? `invited by ${invitation.invitedByName}` : null,
              invitation.expiresAt
                ? `expires ${new Date(invitation.expiresAt).toLocaleDateString()}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        {awaitingApproval ? (
          <Pill className="shrink-0" radius="chip" size="sm" tone="warning">Needs approval</Pill>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {awaitingApproval ? (
          <>
            <button
              className="admin-button admin-button-primary admin-button-compact"
              disabled={busy}
              onClick={() =>
                void act(
                  () => review.mutateAsync({ action: 'approve', inviteId: invitation.inviteId }),
                  'Failed to approve invitation',
                )}
              type="button"
            >
              Approve
            </button>
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={busy}
              onClick={() =>
                void act(
                  () => review.mutateAsync({ action: 'deny', inviteId: invitation.inviteId }),
                  'Failed to deny invitation',
                )}
              type="button"
            >
              Deny
            </button>
          </>
        ) : (
          <>
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={busy}
              onClick={() =>
                void act(
                  () => resend.mutateAsync({ inviteId: invitation.inviteId }),
                  'Failed to resend invitation',
                )}
              type="button"
            >
              Resend
            </button>
            {/*
              Withdraw an invitation that is out in the world — the counterpart
              to Resend, and the only stop verb for an invite past the approval
              queue. Revoking twice is fine; an accepted one is refused in words.
            */}
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={busy}
              onClick={() =>
                void act(
                  () => revoke.mutateAsync({ inviteId: invitation.inviteId }),
                  'Failed to revoke invitation',
                )}
              type="button"
            >
              Revoke
            </button>
          </>
        )}
      </div>

      {error ? (
        <div className="mt-2 text-xs text-[color:var(--danger-text)]" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  )
}

const InviteForm = () => {
  const createInvitations = useCreateWorkspaceInvitations()
  const [email, setEmail] = useState('')
  const [teamRole, setTeamRole] = useState<string>('member')
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFeedback(null)
    try {
      const response = await createInvitations.mutateAsync({
        invites: [{ email: email.trim(), teamRole }],
      })
      setEmail('')
      setTeamRole('member')
      setFeedback({
        kind: 'success',
        // UOA decides the outcome per address (invited, already a member, …).
        message: response.results[0]?.status
          ? `Invitation ${response.results[0].status.replace(/_/g, ' ')}.`
          : 'Invitation sent.',
      })
    } catch (caught) {
      setFeedback({ kind: 'error', message: errorMessage(caught, 'Failed to send invitation.') })
    }
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={submit}>
      <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
        Email
        <input
          className="admin-input"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
          type="email"
          value={email}
        />
      </label>
      <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
        Role
        <select
          className="admin-input"
          onChange={(event) => setTeamRole(event.target.value)}
          value={teamRole}
        >
          {TEAM_ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button
        className={[
          'admin-button admin-button-primary justify-self-start',
          'disabled:cursor-not-allowed disabled:opacity-60',
        ].join(' ')}
        disabled={createInvitations.isPending || email.trim().length === 0}
        type="submit"
      >
        {createInvitations.isPending ? 'Sending…' : 'Send invitation'}
      </button>
      <p className="text-xs text-[color:var(--tx3)]">
        UnlikeOtherAI emails the invitation and hosts the acceptance page.
      </p>
      <FeedbackBanner feedback={feedback} />
    </form>
  )
}

export const WorkspaceMembersSection = ({ canManage }: { canManage: boolean }) => {
  const members = useWorkspaceMembers()
  // Invitation emails are PII; the API serves this list to owners and admins only.
  const invitations = useWorkspaceInvitations(canManage)

  const memberRows = members.data?.members ?? []
  const invitationRows = (invitations.data?.invitations ?? []).filter(
    (invitation) => (invitation.status ?? 'pending') === 'pending',
  )

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className="admin-card p-4">
        <SectionLabel>People</SectionLabel>
        <div className="mt-4 grid gap-2" data-testid="workspace-member-list">
          {members.isError ? (
            <FeedbackBanner
              feedback={{
                kind: 'error',
                message: 'The UnlikeOtherAI directory could not be reached.',
              }}
            />
          ) : null}
          {memberRows.map((member) => (
            <MemberRow canManage={canManage} key={member.uoaSub} member={member} />
          ))}
          {!members.isLoading && !members.isError && memberRows.length === 0 ? (
            <div className="text-sm text-[color:var(--tx2)]">
              This workspace has no members in UnlikeOtherAI yet.
            </div>
          ) : null}
        </div>
      </section>

      {canManage ? (
        <div className="grid content-start gap-4">
          <section className="admin-card p-4">
            <SectionLabel>Invite to workspace</SectionLabel>
            <InviteForm />
          </section>

          <section className="admin-card p-4">
            <SectionLabel>Pending invitations</SectionLabel>
            <div className="mt-4 grid gap-2" data-testid="workspace-invitation-list">
              {invitationRows.map((invitation) => (
                <InvitationRow invitation={invitation} key={invitation.inviteId} />
              ))}
              {!invitations.isLoading && invitationRows.length === 0 ? (
                <div className="text-sm text-[color:var(--tx2)]">No invitations are waiting.</div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
