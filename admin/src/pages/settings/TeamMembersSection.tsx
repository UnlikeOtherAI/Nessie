import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TeamInvitationRecord } from '@nessie/schemas'
import { buildPeopleAgentsTree } from '../../components/features/members/people-agents-tree'
import { useAgents } from '../../facades/agents/queries'
import {
  useCreateTeamInvitation,
  useResendTeamInvitation,
  useReviewTeamInvitation,
  useRevokeTeamInvitation,
  useTeamInvitations,
  useTeamMembers,
} from '../../facades/users/team-members'
import { TeamAgentBuckets, TeamMemberRow } from './TeamMemberPeople'
import { FeedbackBanner } from './FeedbackBanner'
import { Pill } from '../../components/primitives/Pill'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { formErrorMessage, toFormErrors } from '../../facades/forms/form-errors'
import { Card } from '../../components/shared/Card'
import { EmptyState } from '../../components/shared/EmptyState'
import { FormActions, FormError, FormSuccess } from '../../components/shared/FormActions'
import { FormField } from '../../components/shared/FormField'
import { Input } from '../../components/shared/FormControls'
import { Section } from '../../components/shared/PageBody'

/**
 * The team roster on an UnlikeOtherAI session: people, their team
 * role, and the invitations that are still in flight — all read live from UOA,
 * none of it stored by Nessie. Invitation acceptance is hosted by UOA, so there
 * is no accept flow here, and there is no "add member with a password" form:
 * an invitation is how somebody joins.
 */

// `GET /team/members` has no member or invitation parameter. A 404 from
// the relay therefore identifies its active UOA team, even though the
// shared mutation error code is also used for a missing member or invitation.
const teamNeedsReconnect = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && 'status' in error
  && (
    error.code === 'TEAM_NOT_LINKED'
    || (error.code === 'TEAM_MEMBERS_REJECTED' && error.status === 404)
  )

export const InvitationRow = ({ invitation }: { invitation: TeamInvitationRecord }) => {
  const { t, i18n } = useTranslation('settings')
  const resend = useResendTeamInvitation()
  const review = useReviewTeamInvitation()
  const revoke = useRevokeTeamInvitation()
  const [error, setError] = useState<string | null>(null)

  const awaitingApproval = invitation.approvalStatus === 'pending'
  const busy = resend.isPending || review.isPending || revoke.isPending

  const act = async (run: () => Promise<unknown>, fallback: string) => {
    setError(null)
    try {
      await run()
    } catch (caught) {
      setError(formErrorMessage(caught, fallback))
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
              invitation.invitedByName ? t('members.teamSection.invitedBy', { name: invitation.invitedByName }) : null,
              invitation.expiresAt
                ? t('members.teamSection.expires', { date: new Date(invitation.expiresAt).toLocaleDateString(i18n.resolvedLanguage ?? i18n.language) })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        {awaitingApproval ? (
          <Pill className="shrink-0" radius="chip" size="sm" tone="warning" uppercase={false}>
            {t('members.teamSection.needsApproval')}
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
                  t('members.teamSection.approveFailed'),
                )}
              type="button"
            >
              {t('members.teamSection.approve')}
            </button>
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={busy}
              onClick={() =>
                void act(
                  () => review.mutateAsync({ action: 'deny', inviteId: invitation.inviteId }),
                  t('members.teamSection.denyFailed'),
                )}
              type="button"
            >
              {t('members.teamSection.deny')}
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
                  t('members.teamSection.resendFailed'),
                )}
              type="button"
            >
              {t('members.invitationDetails.resend')}
            </button>
            {/*
              Withdraw an invitation that is out in the world — the counterpart
              to Resend, and the only stop verb for an invite past the approval
              queue. Cancelling twice is fine; an accepted one is refused in words.
              The route is still called revoke; the person-facing verb matches
              the roster's "Cancel invitation".
            */}
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={busy}
              onClick={() =>
                void act(
                  () => revoke.mutateAsync({ inviteId: invitation.inviteId }),
                  t('members.teamSection.cancelFailed'),
                )}
              type="button"
            >
              {t('members.invitationDetails.cancel')}
            </button>
          </>
        )}
      </div>

      <FormError className="mt-2">{error}</FormError>
    </Card>
  )
}

const InviteForm = ({ teamLabel }: { teamLabel?: string }) => {
  const { t } = useTranslation('settings')
  const createInvitation = useCreateTeamInvitation()
  const [email, setEmail] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [success, setSuccess] = useState<string | undefined>(undefined)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFieldErrors({})
    setFormError(undefined)
    setSuccess(undefined)
    const address = email.trim()
    try {
      // An invitation is always for an ordinary member — the same body the
      // roster's invite dialog sends. A role is changed after someone joins.
      await createInvitation.mutateAsync({ email: address })
      setEmail('')
      // UOA decides the outcome for the address (invited, already a member, …)
      // and says so on its own hosted page; the route answers `{ok:true}` for
      // every accepted outcome, so there is no per-address verdict to relay.
      setSuccess(t('members.teamSection.sentTo', { email: address }))
    } catch (caught) {
      const { fieldErrors: nextFieldErrors, formError: nextFormError } = toFormErrors(caught)
      setFieldErrors(nextFieldErrors)
      setFormError(nextFormError ?? formErrorMessage(caught, t('members.teamSection.sendFailed')))
    }
  }

  return (
    <form className="mt-4 grid gap-3" onSubmit={submit}>
      <FormField error={fieldErrors.email} label={t('members.invite.email')}>
        <Input
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
          type="email"
          value={email}
        />
      </FormField>
      <p className="text-xs text-[color:var(--tx3)]">
        {t('members.teamSection.inviteHelp', { team: teamLabel ?? t('team.team') })}
      </p>
      <FormError>{formError}</FormError>
      <FormSuccess>{success}</FormSuccess>
      <FormActions>
        <button
          className="admin-button admin-button-primary disabled:cursor-not-allowed disabled:opacity-60"
          disabled={createInvitation.isPending || email.trim().length === 0}
          type="submit"
        >
          {createInvitation.isPending ? t('members.invite.sending') : t('members.invite.send')}
        </button>
      </FormActions>
    </form>
  )
}

/**
 * The invite card, standalone: the organisation members page reuses it as-is
 * — a UOA invitation always lands in one team (there is no team-less invite),
 * so inviting from the org page is inviting into the session's active team,
 * and the form says so when `teamLabel` is passed.
 */
export const InviteToTeamCard = ({ teamLabel }: { teamLabel?: string }) => {
  const { t } = useTranslation('settings')
  return (
    <Card as="section">
      <SectionLabel>{t('members.teamSection.inviteToTeam')}</SectionLabel>
      <InviteForm teamLabel={teamLabel} />
    </Card>
  )
}

export const TeamMembersSection = ({
  canManage,
  onReconnect,
  pausedPrivateAgentCount = 0,
}: {
  canManage: boolean
  onReconnect?: () => Promise<void>
  pausedPrivateAgentCount?: number
}) => {
  const { t } = useTranslation('settings')
  const members = useTeamMembers()
  const needsTeamReconnect = teamNeedsReconnect(members.error)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [reconnectError, setReconnectError] = useState<string | null>(null)
  // Invitation emails are PII; the API serves this list to owners and admins only.
  // A linked roster is the prerequisite for invitation management. Waiting for
  // it avoids issuing a second, guaranteed-404 UOA request when that roster's
  // active UOA team cannot be reached.
  const invitations = useTeamInvitations(canManage && members.isSuccess)
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
  const hasUnassignedAgents = !needsTeamReconnect && (
    tree.pausedPrivateAgentCount > 0
    || tree.teamOwned.length > 0
    || tree.ownedOutsideTeam.length > 0
  )

  const reconnect = async (): Promise<void> => {
    if (!onReconnect) return
    setReconnectError(null)
    setIsReconnecting(true)
    try {
      await onReconnect()
    } catch (error) {
      setReconnectError(formErrorMessage(error, t('members.teamSection.reconnectFailed')))
    } finally {
      setIsReconnecting(false)
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section title={t('members.local.people')}>
        <div className="grid gap-2" data-testid="team-member-list">
          {needsTeamReconnect ? (
            <FeedbackBanner
              feedback={{
                kind: 'error',
                message: t('members.teamSection.teamNotLinked'),
              }}
            />
          ) : members.isError ? (
            <FeedbackBanner
              feedback={{
                kind: 'error',
                message: t('members.teamSection.membersUnavailable'),
              }}
            />
          ) : members.isLoading ? (
            <p className="text-sm text-[color:var(--tx3)]">{t('members.loadingMembers')}</p>
          ) : null}
          {needsTeamReconnect && onReconnect ? (
            <button
              className="admin-button admin-button-primary justify-self-start"
              disabled={isReconnecting}
              onClick={() => void reconnect()}
              type="button"
            >
              {t(isReconnecting ? 'members.teamSection.openingUoa' : 'members.teamSection.reconnectTeam')}
            </button>
          ) : null}
          {reconnectError ? <FeedbackBanner feedback={{ kind: 'error', message: reconnectError }} /> : null}
          {memberRows.map((member) => (
            <TeamMemberRow
              canManage={canManage}
              key={member.uoaSub}
              member={member}
              ownedAgents={agentsBySub.get(member.uoaSub) ?? []}
            />
          ))}
          {!members.isLoading && !members.isError && memberRows.length === 0 ? (
            <EmptyState>{t('members.teamSection.noTeamMembers')}</EmptyState>
          ) : null}
        </div>

        {/*
          Agents belonging to nobody in this team. Two groups, never one:
          "team-owned" is a state (no steward, so anyone entitled may edit),
          while an owner the *team* roster does not list is equally an active
          colleague on another team — so this bucket describes what is known
          rather than declaring anyone departed.
        */}
        {hasUnassignedAgents ? <TeamAgentBuckets tree={tree} /> : null}
      </Section>

      {canManage && !needsTeamReconnect ? (
        <div className="grid content-start gap-4">
          <InviteToTeamCard />

          <Section title={t('members.pendingInvitations')}>
            <div className="grid gap-2" data-testid="team-invitation-list">
              {invitations.isLoading ? (
                <p className="text-sm text-[color:var(--tx3)]">{t('members.loadingInvitations')}</p>
              ) : null}
              {invitationRows.map((invitation) => (
                <InvitationRow invitation={invitation} key={invitation.inviteId} />
              ))}
              {!invitations.isLoading && invitationRows.length === 0 ? (
                <EmptyState>{t('members.teamSection.noPendingInvitations')}</EmptyState>
              ) : null}
            </div>
          </Section>
        </div>
      ) : null}
    </div>
  )
}
