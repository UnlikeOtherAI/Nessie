import type { UserAlertRecord } from '../../facades/alerts/hooks'
import { teamInvitationLabel } from '../../lib/team-invitation-label'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../../i18n/formatters'

// Shared inner content of one alert row (unread dot, mention text, relative
// timestamp). The wrapping container differs per surface: the top-bar bell
// uses .admin-topbar-menu-item, the /alerts page an admin-card row.
type AlertRowProps = {
  acceptError?: string | null
  accepting?: boolean
  alert: UserAlertRecord
  className?: string
  onAcceptInvitation?: () => void
  onOpen?: () => void
}

const describeAlert = (
  alert: UserAlertRecord,
  translate: (key: string, options?: Record<string, string>) => string,
): string => {
  const actor = alert.actorDisplayName ?? translate('alertRow.someone')
  if (alert.kind === 'team_invitation') {
    if (!alert.metadata) return translate('alertRow.teamInvitation')
    // The organisation is part of the name, not decoration: this row is often
    // the only place a cross-organisation invitation is offered, and "General"
    // on its own does not say which organisation invited you.
    const target = teamInvitationLabel(alert.metadata)
    return alert.metadata.invitedBy
      ? translate('alertRow.invitedBy', { name: alert.metadata.invitedBy, target })
      : translate('alertRow.invitedTo', { target })
  }
  if (alert.kind === 'trigger_health') {
    // No actor: nobody did this, a schedule stopped being able to run.
    return translate('alertRow.triggerStopped')
  }
  if (alert.kind === 'trigger_machine_access') {
    // An agent set this trigger up for the reader, who is its author; its
    // machines are the one thing no agent may set up. The link opens the
    // trigger's Machine access section, where they do.
    const trigger = alert.triggerName ?? translate('alertRow.ticketTrigger')
    return translate('alertRow.machineAccess', { trigger })
  }
  if (alert.kind === 'automatic_membership_health') {
    const team = alert.automaticMembershipRuleTeamName
    return team
      ? translate('alertRow.automaticAccessTeam', { team })
      : translate('alertRow.automaticAccess')
  }
  if (alert.kind === 'board_source_health') {
    // Also no actor, and deliberately without the provider's name: what is
    // wrong belongs on the source's own page, where the remedy is a button.
    return translate('alertRow.boardSourceStopped')
  }
  if (alert.kind === 'local_inference_health') {
    // No host label, model name or failure detail travels through the bell:
    // that data names a private computer and belongs only on its owner-only
    // recovery surface.
    return translate('alertRow.ollamaAttention')
  }
  if (alert.kind === 'board_ticket_changed') {
    // Deliberately without the ticket's title: this reaches a lock screen, and
    // the title is exactly what must not travel there. The row opens the card.
    return translate('alertRow.watchedTicketChanged')
  }
  if (alert.kind === 'workflow_run_failed') {
    return translate('alertRow.workflowFailed')
  }
  if (alert.kind === 'task_set_health') {
    return translate('alertRow.taskSetAttention')
  }
  if (alert.kind === 'approval_requested') {
    // Deliberately generic: the alert body reaches a lock screen, and what is
    // waiting for approval is exactly the thing that must not travel there.
    //
    // A request from a paired agent has no actor to name — the credential acts
    // as the reader themselves, so "Someone needs your approval" would be both
    // vague and, read literally, wrong.
    return alert.actorDisplayName
      ? translate('alertRow.approvalBy', { actor: alert.actorDisplayName })
      : translate('alertRow.agentApproval')
  }
  if (alert.kind === 'task_assigned') return translate('alertRow.taskAssigned', { actor })
  if (alert.kind === 'knowledge_published') return translate('alertRow.knowledgePublished', { actor })
  // Deliberately without the document's title: this row reaches a bell a
  // colleague may be looking over, and the title of somebody's private
  // document is exactly what a one-line summary must not carry. The row opens
  // it, and Shared with me lists it.
  if (alert.kind === 'knowledge_shared') return translate('alertRow.documentShared', { actor })
  if (alert.kind === 'call_missed') {
    return alert.channelLabel
      ? translate('alertRow.missedCallIn', { actor, channel: alert.channelLabel })
      : translate('alertRow.missedCall', { actor })
  }
  return alert.channelLabel
    ? translate('alertRow.mentionedIn', { actor, channel: alert.channelLabel })
    : translate('alertRow.mentioned', { actor })
}

export const AlertRow = ({
  acceptError,
  accepting = false,
  alert,
  className,
  onAcceptInvitation,
  onOpen,
}: AlertRowProps) => {
  const { t, i18n } = useTranslation('inbox')
  const unread = alert.readAt === null
  const invite = alert.kind === 'team_invitation' ? alert.metadata : null
  const description = describeAlert(alert, t)

  return (
    <div className={['flex w-full flex-wrap items-center gap-2', className ?? ''].join(' ')}>
      <button
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onOpen}
        type="button"
      >
        <span
          aria-hidden="true"
          className={[
            'mt-1.5 h-2 w-2 shrink-0 rounded-full',
            unread ? 'bg-[color:var(--accent)]' : '',
          ].join(' ')}
        />
        <span
          className={[
            'min-w-0 flex-1',
            unread ? 'font-semibold text-[color:var(--tx)]' : 'text-[color:var(--tx2)]',
          ].join(' ')}
        >
          {description}
        </span>
        <span className="shrink-0 text-xs font-normal text-[color:var(--tx3)]">
          {formatRelativeTime(alert.createdAt, i18n.resolvedLanguage ?? i18n.language)}
        </span>
      </button>
      {invite && onAcceptInvitation ? (
        <button
          className="rounded-md bg-[color:var(--accent)] px-2 py-1 text-xs font-semibold text-[color:var(--on-accent)] disabled:opacity-60"
          disabled={accepting}
          onClick={onAcceptInvitation}
          type="button"
        >
          {accepting ? t('alertRow.accepting') : t('alertRow.accept')}
        </button>
      ) : null}
      {acceptError ? (
        <span className="w-full text-xs text-[color:var(--danger-text)]" role="alert">
          {acceptError}
        </span>
      ) : null}
    </div>
  )
}
