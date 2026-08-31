import { useState, type FormEvent } from 'react'
import { ApiClientError } from '@nessie/client-core'
import type { WorkspaceInvitationRecord } from '@nessie/schemas'
import { buildPeopleAgentsTree } from '../../components/features/members/people-agents-tree'
import { useAgents } from '../../facades/agents/queries'
import {
  useCreateWorkspaceInvitations,
  useResendWorkspaceInvitation,
  useReviewWorkspaceInvitation,
  useRevokeWorkspaceInvitation,
  useWorkspaceInvitations,
  useWorkspaceMembers,
} from '../../facades/users/workspace-members'
import {
  WorkspaceAgentBuckets,
  WorkspaceMemberRow,
  WORKSPACE_TEAM_ROLE_OPTIONS,
} from './WorkspaceMemberPeople'
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

const errorMessage = (caught: unknown, fallback: string): string =>
  caught instanceof Error ? caught.message : fallback

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
          {WORKSPACE_TEAM_ROLE_OPTIONS.map((option) => (
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

export const WorkspaceMembersSection = ({
  canManage,
  onReconnect,
  pausedPrivateAgentCount = 0,
}: {
  canManage: boolean
  onReconnect?: () => Promise<void>
  pausedPrivateAgentCount?: number
}) => {
  const members = useWorkspaceMembers()
  const workspaceNotLinked =
    members.error instanceof ApiClientError && members.error.code === 'WORKSPACE_NOT_LINKED'
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [reconnectError, setReconnectError] = useState<string | null>(null)
  // Invitation emails are PII; the API serves this list to owners and admins only.
  // A linked roster is the prerequisite for invitation management. Waiting for
  // it avoids issuing a second, guaranteed-404 UOA request when the local
  // workspace binding is gone.
  const invitations = useWorkspaceInvitations(canManage && members.isSuccess)
  // `scope: 'all'` so the system tier is classified into its own bucket rather
  // than silently missing from the tree. Entitlement is unchanged — the system
  // tier is still only reachable through a channel the viewer can already see.
  const agents = useAgents({ scope: 'all' })

  const memberRows = members.data?.members ?? []
  // Array-guarded: this is the boundary where a query result enters the pure
  // tree builder, and a client that is loading, errored, or stubbed can hand
  // back something that is not a list.
  const tree = buildPeopleAgentsTree(
    memberRows,
    Array.isArray(agents.data) ? agents.data : [],
    { pausedPrivateAgentCount },
  )
  const agentsBySub = new Map(
    tree.people.map((person) => [person.member.uoaSub, person.agents]),
  )
  const invitationRows = (invitations.data?.invitations ?? []).filter(
    (invitation) => (invitation.status ?? 'pending') === 'pending',
  )
  const hasUnassignedAgents = !workspaceNotLinked && (
    tree.pausedPrivateAgentCount > 0
    || tree.unowned.length > 0
    || tree.ownedOutsideWorkspace.length > 0
  )

  const reconnect = async (): Promise<void> => {
    if (!onReconnect) return
    setReconnectError(null)
    setIsReconnecting(true)
    try {
      await onReconnect()
    } catch (error) {
      setReconnectError(errorMessage(error, 'Unable to reconnect this workspace.'))
    } finally {
      setIsReconnecting(false)
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className="admin-card p-4">
        <SectionLabel>People</SectionLabel>
        <div className="mt-4 grid gap-2" data-testid="workspace-member-list">
          {workspaceNotLinked ? (
            <FeedbackBanner
              feedback={{
                kind: 'error',
                message: 'This Nessie workspace is no longer linked to the active UnlikeOtherAI workspace.',
              }}
            />
          ) : members.isError ? (
            <FeedbackBanner
              feedback={{
                kind: 'error',
                message: 'The UnlikeOtherAI directory could not be reached.',
              }}
            />
          ) : null}
          {workspaceNotLinked && onReconnect ? (
            <button
              className="admin-button admin-button-primary justify-self-start"
              disabled={isReconnecting}
              onClick={() => void reconnect()}
              type="button"
            >
              {isReconnecting ? 'Opening UnlikeOtherAI…' : 'Reconnect workspace'}
            </button>
          ) : null}
          {reconnectError ? <FeedbackBanner feedback={{ kind: 'error', message: reconnectError }} /> : null}
          {memberRows.map((member) => (
            <WorkspaceMemberRow
              canManage={canManage}
              key={member.uoaSub}
              member={member}
              ownedAgents={agentsBySub.get(member.uoaSub) ?? []}
            />
          ))}
          {!members.isLoading && !members.isError && memberRows.length === 0 ? (
            <div className="text-sm text-[color:var(--tx2)]">
              This workspace has no members in UnlikeOtherAI yet.
            </div>
          ) : null}
        </div>

        {/*
          Agents belonging to nobody in this workspace. Two groups, never one:
          "unowned" predates stewardship, while an owner the *team* roster does
          not list is equally an active colleague on another team — so this
          bucket describes what is known rather than declaring anyone departed.
        */}
        {hasUnassignedAgents ? <WorkspaceAgentBuckets tree={tree} /> : null}
      </section>

      {canManage && !workspaceNotLinked ? (
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
