import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { CallRecord } from '../../../lib/api-client'
import { openExternalUrl, usesExternalUrlShell } from '../../../lib/open-external-url'
import {
  callProviderLabel,
  presentStartCallFailure,
} from '../../../facades/calls/call-presentation'
import { Dialog } from '../../shared/Dialog'

type CallerCallDialogProps = {
  actionError: unknown
  actionPending: boolean
  canManageCallSettings?: boolean
  call: CallRecord
  channelLabel: string
  onCancel: () => void
  onClose: () => void
  onEnd: () => void
}

type StartCallFailureDialogProps = {
  code: string | undefined
  existingCall: CallRecord | null | undefined
  onClose: () => void
  open: boolean
}

const invitationStateKey: Record<CallRecord['invites'][number]['state'], string> = {
  accepted: 'child.call.invite.accepted',
  cancelled: 'child.call.invite.cancelled',
  declined: 'child.call.invite.declined',
  missed: 'child.call.invite.missed',
  ringing: 'child.call.invite.waiting',
}

const actionErrorMessage = (error: unknown): string | null =>
  error instanceof Error ? error.message : null

const ExternalMeetingAnchor = ({
  children,
  className,
  meetingUri,
}: {
  children: string
  className: string
  meetingUri: string
}) => {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!usesExternalUrlShell()) return
    event.preventDefault()
    void openExternalUrl(meetingUri)
  }

  return (
    <a
      className={className}
      href={meetingUri}
      onClick={onClick}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
    </a>
  )
}

/** The caller's controls; the meeting itself always opens outside Nessie. */
export const CallerCallDialog = ({
  actionError,
  actionPending,
  canManageCallSettings = false,
  call,
  channelLabel,
  onCancel,
  onClose,
  onEnd,
}: CallerCallDialogProps) => {
  const { t } = useTranslation('channels')
  const joinLinkRef = useRef<HTMLAnchorElement>(null)
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const canCancel = call.status === 'ringing'
  const canEnd = call.status === 'active'
  const providerLabel = callProviderLabel(call.provider)

  useEffect(() => {
    setCopyMessage(null)
  }, [call.id])

  const copyLink = async () => {
    if (!call.meetingUri || !navigator.clipboard) {
      setCopyMessage(t('child.call.copyUnavailable'))
      return
    }
    try {
      await navigator.clipboard.writeText(call.meetingUri)
      setCopyMessage(t('child.call.linkCopied'))
    } catch {
      setCopyMessage(t('child.call.copyFailed'))
    }
  }

  return (
    <Dialog
      description={(
        <>
          {t('child.call.inChannel', { channel: channelLabel })} {t('child.call.via')} {canManageCallSettings ? (
            <Link className="text-[color:var(--accent)] underline-offset-2 hover:underline" to="/settings/organization">
              {providerLabel}
            </Link>
          ) : providerLabel}
        </>
      )}
      dismissDisabled={actionPending}
      initialFocusRef={joinLinkRef}
      onClose={onClose}
      open
      title={t('child.call.started')}
    >
      <div className="grid gap-5">
        <p className="text-sm text-[color:var(--tx2)]">
          {call.status === 'ringing' ? t('child.call.waitingForResponses') : t('child.call.linkReady')}
        </p>

        {call.meetingUri ? (
          <div className="grid gap-2 rounded-lg border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-3">
            <ExternalMeetingAnchor
              className="break-all text-sm font-medium text-[color:var(--accent)] underline-offset-2 hover:underline"
              meetingUri={call.meetingUri}
            >
              {t('incomingCall.join')}
            </ExternalMeetingAnchor>
            <div className="flex items-center gap-2">
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={() => void copyLink()}
                type="button"
              >
                {t('child.call.copyLink')}
              </button>
              {copyMessage ? (
                <span aria-live="polite" className="text-xs text-[color:var(--tx3)]">
                  {copyMessage}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="grid gap-2">
          <h3 className="text-sm font-medium text-[color:var(--tx)]">{t('child.call.responses')}</h3>
          {call.invites.length === 0 ? (
            <p className="text-sm text-[color:var(--tx3)]">{t('child.call.noResponses')}</p>
          ) : (
            <ul className="divide-y divide-[color:var(--sep)] rounded-md border border-[color:var(--sep)]">
              {call.invites.map((invite) => (
                <li
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  key={invite.userId}
                >
                  <span className="truncate text-[color:var(--tx)]">{invite.displayName}</span>
                  <span className="flex-shrink-0 text-[color:var(--tx3)]">
                    {t(invitationStateKey[invite.state])}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {actionErrorMessage(actionError) ? (
          <p className="text-sm text-[color:var(--danger-text)]" role="alert">
            {actionErrorMessage(actionError)}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            className="admin-button admin-button-secondary"
            disabled={actionPending}
            onClick={onClose}
            type="button"
          >
            {t('incomingCall.close')}
          </button>
          {canCancel ? (
            <button
              className="admin-button admin-button-danger"
              disabled={actionPending}
              onClick={onCancel}
              type="button"
            >
              {actionPending ? t('child.call.cancelling') : t('child.call.cancel')}
            </button>
          ) : null}
          {canEnd ? (
            <button
              className="admin-button admin-button-danger"
              disabled={actionPending}
              onClick={onEnd}
              type="button"
            >
              {actionPending ? t('child.call.ending') : t('child.call.end')}
            </button>
          ) : null}
        </div>
      </div>
    </Dialog>
  )
}

/** Explains a start refusal and gives the caller its direct recovery doorway. */
export const StartCallFailureDialog = ({
  code,
  existingCall,
  onClose,
  open,
}: StartCallFailureDialogProps) => {
  const { t } = useTranslation('channels')
  const failure = presentStartCallFailure(code)
  const isExistingCall = code === 'ACTIVE_CALL_EXISTS'
  const connectLabel = t(failure.connection === 'microsoft' ? 'child.call.connectMicrosoft' : 'child.call.connectGoogle')
  const failureKey = code === 'GOOGLE_NOT_CONNECTED' ? 'googleNotConnected'
    : code === 'MEET_SCOPE_MISSING' ? 'meetScopeMissing'
      : code === 'GOOGLE_REAUTH_REQUIRED' ? 'googleReauthRequired'
        : code === 'MICROSOFT_NOT_CONNECTED' ? 'microsoftNotConnected'
          : code === 'ACTIVE_CALL_EXISTS' ? 'alreadyRunning'
            : 'startFailed'

  return (
    <Dialog
      onClose={onClose}
      open={open}
      title={t(isExistingCall ? 'child.call.alreadyRunningTitle' : 'child.call.startFailedTitle')}
    >
      <div className="grid gap-4">
        <p className="text-sm text-[color:var(--tx2)]">
          {isExistingCall && existingCall?.meetingUri
            ? t('child.call.alreadyRunning')
            : t(`child.call.failure.${failureKey}`)}
        </p>
        {isExistingCall && existingCall?.meetingUri ? (
          <ExternalMeetingAnchor
            className="admin-button admin-button-primary justify-self-start"
            meetingUri={existingCall.meetingUri}
          >
            {t('child.call.joinExisting')}
          </ExternalMeetingAnchor>
        ) : failure.connection ? (
          <Link className="admin-button admin-button-primary justify-self-start" to="/settings/connections">
            {connectLabel}
          </Link>
        ) : null}
        <div className="flex justify-end">
          <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
            {t('incomingCall.close')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
