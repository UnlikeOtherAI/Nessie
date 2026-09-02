import { useState, type FormEvent } from 'react'
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
import { FeedbackBanner } from './settings-shared'
import { Pill } from '../../components/primitives/Pill'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { toFormErrors } from '../../facades/form-errors'
import { Card } from '../../components/shared/Card'
import { EmptyState } from '../../components/shared/EmptyState'
import { FormActions, FormError, FormSuccess } from '../../components/shared/FormActions'
import { FormField } from '../../components/shared/FormField'
import { Input, Select } from '../../components/shared/FormControls'
import { Section } from '../../components/shared/PageBody'

/**
 * The workspace roster on an UnlikeOtherAI session: people, their workspace
 * role, and the invitations that are still in flight — all read live from UOA,
 * none of it stored by Nessie. Invitation acceptance is hosted by UOA, so there
 * is no accept flow here, and there is no "add member with a password" form:
 * an invitation is how somebody joins.
 */

const errorMessage = (caught: unknown, fallback: string): string =>
  caught instanceof Error ? caught.message : fallback

// `GET /workspace/members` has no member or invitation parameter. A 404 from
// the relay therefore identifies its active UOA workspace, even though the
// shared mutation error code is also used for a missing member or invitation.
const workspaceNeedsReconnect = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && 'status' in error
  && (
    error.code === 'WORKSPACE_NOT_LINKED'
    || (error.code === 'WORKSPACE_MEMBERS_REJECTED' && error.status === 404)
  )

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
    <Card variant="row">
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
          <Pill className="shrink-0" radius="chip" size="sm" tone="warning" uppercase={false}>
            Needs approval
          </Pill>
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

      <FormError className="mt-2">{error}</FormError>
    </Card>
  )
}

const InviteForm = () => {
  const createInvitations = useCreateWorkspaceInvitations()
  const [email, setEmail] = useState('')
  const [teamRole, setTeamRole] = useState<string>('member')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [success, setSuccess] = useState<string | undefined>(undefined)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFieldErrors({})
    setFormError(undefined)
    setSuccess(undefined)
    try {
      const response = await createInvitations.mutateAsync({
        invites: [{ email: email.trim(), teamRole }],
      })
      setEmail('')
      setTeamRole('member')
      // UOA decides the outcome per address (invited, already a member, …).
      setSuccess(
        response.results[0]?.status
          ? `Invitation ${response.results[0].status.replace(/_/g, ' ')}.`
          : 'Invitation sent.',
      )
    } catch (caught) {
      const { fieldErrors: nextFieldErrors, formError: nextFormError } = toFormErrors(caught)
      setFieldErrors(nextFieldErrors)
      setFormError(nextFormError ?? errorMessage(caught, 'Failed to send invitation.'))
    }
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={submit}>
      <FormField error={fieldErrors.email} label="Email">
        <Input
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
          type="email"
          value={email}
        />
      </FormField>
      <FormField label="Role">
        <Select
          onChange={(event) => setTeamRole(event.target.value)}
          value={teamRole}
        >
          {WORKSPACE_TEAM_ROLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </FormField>
      <p className="text-xs text-[color:var(--tx3)]">
        UnlikeOtherAI emails the invitation and hosts the acceptance page.
      </p>
      <FormError>{formError}</FormError>
      <FormSuccess>{success}</FormSuccess>
      <FormActions>
        <button
          className="admin-button admin-button-primary disabled:cursor-not-allowed disabled:opacity-60"
          disabled={createInvitations.isPending || email.trim().length === 0}
          type="submit"
        >
          {createInvitations.isPending ? 'Sending…' : 'Send invitation'}
        </button>
      </FormActions>
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
  const needsWorkspaceReconnect = workspaceNeedsReconnect(members.error)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [reconnectError, setReconnectError] = useState<string | null>(null)
  // Invitation emails are PII; the API serves this list to owners and admins only.
  // A linked roster is the prerequisite for invitation management. Waiting for
  // it avoids issuing a second, guaranteed-404 UOA request when that roster's
  // active UOA workspace cannot be reached.
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
  const hasUnassignedAgents = !needsWorkspaceReconnect && (
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
      <Section title="People">
        <div className="grid gap-2" data-testid="workspace-member-list">
          {needsWorkspaceReconnect ? (
            <FeedbackBanner
              feedback={{
                kind: 'error',
                message: 'This Nessie workspace can no longer be reached through UnlikeOtherAI.',
              }}
            />
          ) : members.isError ? (
            <FeedbackBanner
              feedback={{
                kind: 'error',
                message: 'The UnlikeOtherAI directory could not be reached.',
              }}
            />
          ) : members.isLoading ? (
            <p className="text-sm text-[color:var(--tx3)]">Loading members…</p>
          ) : null}
          {needsWorkspaceReconnect && onReconnect ? (
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
            <EmptyState>This workspace has no members in UnlikeOtherAI yet.</EmptyState>
          ) : null}
        </div>

        {/*
          Agents belonging to nobody in this workspace. Two groups, never one:
          "unowned" predates stewardship, while an owner the *team* roster does
          not list is equally an active colleague on another team — so this
          bucket describes what is known rather than declaring anyone departed.
        */}
        {hasUnassignedAgents ? <WorkspaceAgentBuckets tree={tree} /> : null}
      </Section>

      {canManage && !needsWorkspaceReconnect ? (
        <div className="grid content-start gap-4">
          <Card as="section">
            <SectionLabel>Invite to workspace</SectionLabel>
            <InviteForm />
          </Card>

          <Section title="Pending invitations">
            <div className="grid gap-2" data-testid="workspace-invitation-list">
              {invitations.isLoading ? (
                <p className="text-sm text-[color:var(--tx3)]">Loading invitations…</p>
              ) : null}
              {invitationRows.map((invitation) => (
                <InvitationRow invitation={invitation} key={invitation.inviteId} />
              ))}
              {!invitations.isLoading && invitationRows.length === 0 ? (
                <EmptyState>No invitations are waiting.</EmptyState>
              ) : null}
            </div>
          </Section>
        </div>
      ) : null}
    </div>
  )
}
