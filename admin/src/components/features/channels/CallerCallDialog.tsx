import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
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

const invitationStateLabel: Record<CallRecord['invites'][number]['state'], string> = {
  accepted: 'Accepted',
  cancelled: 'Cancelled',
  declined: 'Declined',
  missed: 'Missed',
  ringing: 'Waiting for response',
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
      setCopyMessage('Copy is unavailable in this browser.')
      return
    }
    try {
      await navigator.clipboard.writeText(call.meetingUri)
      setCopyMessage('Link copied.')
    } catch {
      setCopyMessage('Unable to copy the link.')
    }
  }

  return (
    <Dialog
      description={(
        <>
          in #{channelLabel} via {canManageCallSettings ? (
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
      title="Call started"
    >
      <div className="grid gap-5">
        <p className="text-sm text-[color:var(--tx2)]">
          {call.status === 'ringing' ? 'Waiting for responses.' : 'This call link is ready to join.'}
        </p>

        {call.meetingUri ? (
          <div className="grid gap-2 rounded-lg border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-3">
            <ExternalMeetingAnchor
              className="break-all text-sm font-medium text-[color:var(--accent)] underline-offset-2 hover:underline"
              meetingUri={call.meetingUri}
            >
              Join call
            </ExternalMeetingAnchor>
            <div className="flex items-center gap-2">
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={() => void copyLink()}
                type="button"
              >
                Copy link
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
          <h3 className="text-sm font-medium text-[color:var(--tx)]">Responses</h3>
          {call.invites.length === 0 ? (
            <p className="text-sm text-[color:var(--tx3)]">No one else needs a response.</p>
          ) : (
            <ul className="divide-y divide-[color:var(--sep)] rounded-md border border-[color:var(--sep)]">
              {call.invites.map((invite) => (
                <li
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  key={invite.userId}
                >
                  <span className="truncate text-[color:var(--tx)]">{invite.displayName}</span>
                  <span className="flex-shrink-0 text-[color:var(--tx3)]">
                    {invitationStateLabel[invite.state]}
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
            Close
          </button>
          {canCancel ? (
            <button
              className="admin-button admin-button-danger"
              disabled={actionPending}
              onClick={onCancel}
              type="button"
            >
              {actionPending ? 'Cancelling…' : 'Cancel call'}
            </button>
          ) : null}
          {canEnd ? (
            <button
              className="admin-button admin-button-danger"
              disabled={actionPending}
              onClick={onEnd}
              type="button"
            >
              {actionPending ? 'Ending…' : 'End call'}
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
  const failure = presentStartCallFailure(code)
  const isExistingCall = code === 'ACTIVE_CALL_EXISTS'
  const connectLabel = failure.connection === 'microsoft' ? 'Connect Microsoft' : 'Connect Google'

  return (
    <Dialog
      onClose={onClose}
      open={open}
      title={isExistingCall ? 'Call already in progress' : 'Couldn’t start call'}
    >
      <div className="grid gap-4">
        <p className="text-sm text-[color:var(--tx2)]">
          {isExistingCall && existingCall?.meetingUri
            ? 'A call is already happening in this channel. You can join it.'
            : failure.message}
        </p>
        {isExistingCall && existingCall?.meetingUri ? (
          <ExternalMeetingAnchor
            className="admin-button admin-button-primary justify-self-start"
            meetingUri={existingCall.meetingUri}
          >
            Join existing call
          </ExternalMeetingAnchor>
        ) : failure.connection ? (
          <Link className="admin-button admin-button-primary justify-self-start" to="/settings/connections">
            {connectLabel}
          </Link>
        ) : null}
        <div className="flex justify-end">
          <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </Dialog>
  )
}
