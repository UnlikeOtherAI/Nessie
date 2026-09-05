import { isDesktopApp } from '../../lib/desktop'
import { isReactNativeWebView } from '../../lib/native-shell'
import { Dialog } from './Dialog'
import type { CallIncomingEvent } from '@nessie/schemas'

export type IncomingCallPresentation = 'missed' | 'open' | 'retry' | 'ringing'

type IncomingCallDialogProps = {
  call: CallIncomingEvent | null
  onAccept: () => void
  onClose: () => void
  onDecline: () => void
  onJoin: () => void
  pending: boolean
  presentation: IncomingCallPresentation
}

const isNativeShell = (): boolean => isDesktopApp() || isReactNativeWebView()

const ExternalJoinControl = ({ call, label, onOpen }: {
  call: CallIncomingEvent
  label: string
  onOpen: () => void
}) => isNativeShell() ? (
  <button className="admin-button admin-button-primary" onClick={onOpen} type="button">{label}</button>
) : (
  <a
    className="admin-button admin-button-primary"
    href={call.meetingUri}
    rel="noopener noreferrer"
    target="_blank"
  >
    {label}
  </a>
)

/** A real browser anchor handles Accept; shells use their trusted external opener. */
export const IncomingCallDialog = ({
  call,
  onAccept,
  onClose,
  onDecline,
  onJoin,
  pending,
  presentation,
}: IncomingCallDialogProps) => {
  const nativeShell = isNativeShell()
  const title = presentation === 'ringing'
    ? 'Incoming call'
    : presentation === 'open'
      ? 'Call is open'
      : presentation === 'missed'
        ? 'Call missed'
        : 'Couldn’t accept call'

  return (
    <Dialog onClose={onClose} open={call !== null} title={title}>
      {call ? (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <p className="text-sm font-medium text-[color:var(--tx)]">{call.caller.displayName} started a call</p>
            <p className="text-sm text-[color:var(--tx2)]">in #{call.channelName}</p>
          </div>

          {presentation === 'ringing' ? (
            <p className="text-sm text-[color:var(--tx2)]">Join when you’re ready, or decline this invitation.</p>
          ) : presentation === 'open' ? (
            <p className="text-sm text-[color:var(--tx2)]">This call is already open. You can still join with the link.</p>
          ) : presentation === 'missed' ? (
            <p className="text-sm text-[color:var(--tx2)]">This call is no longer ringing. The link remains available if the call is still running.</p>
          ) : (
            <p className="text-sm text-[color:var(--danger-text)]">Try accepting again, or join from the link.</p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {presentation === 'ringing' ? (
              <>
                <button className="admin-button admin-button-secondary" disabled={pending} onClick={onDecline} type="button">
                  Decline
                </button>
                {nativeShell ? (
                  <button className="admin-button admin-button-primary" disabled={pending} onClick={onAccept} type="button">
                    Accept
                  </button>
                ) : (
                  <a
                    className="admin-button admin-button-primary"
                    href={call.meetingUri}
                    onClick={onAccept}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Accept
                  </a>
                )}
              </>
            ) : (
              <>
                <button className="admin-button admin-button-secondary" onClick={onClose} type="button">Close</button>
                <ExternalJoinControl call={call} label="Join call" onOpen={onJoin} />
              </>
            )}
          </div>
        </div>
      ) : null}
    </Dialog>
  )
}
