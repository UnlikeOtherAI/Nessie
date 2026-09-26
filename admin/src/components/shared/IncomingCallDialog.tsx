import { isDesktopApp } from '../../lib/desktop'
import { isReactNativeWebView } from '../../lib/native-shell'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('channels')
  const nativeShell = isNativeShell()
  const title = presentation === 'ringing'
    ? t('incomingCall.incoming')
    : presentation === 'open'
      ? t('incomingCall.open')
      : presentation === 'missed'
        ? t('incomingCall.missed')
        : t('incomingCall.acceptError')

  return (
    <Dialog onClose={onClose} open={call !== null} title={title}>
      {call ? (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <p className="text-sm font-medium text-[color:var(--tx)]">{t('incomingCall.started', { name: call.caller.displayName })}</p>
            <p className="text-sm text-[color:var(--tx2)]">{t('incomingCall.inChannel', { channel: call.channelName })}</p>
          </div>

          {presentation === 'ringing' ? (
            <p className="text-sm text-[color:var(--tx2)]">{t('incomingCall.ringingDescription')}</p>
          ) : presentation === 'open' ? (
            <p className="text-sm text-[color:var(--tx2)]">{t('incomingCall.openDescription')}</p>
          ) : presentation === 'missed' ? (
            <p className="text-sm text-[color:var(--tx2)]">{t('incomingCall.missedDescription')}</p>
          ) : (
            <p className="text-sm text-[color:var(--danger-text)]">{t('incomingCall.errorDescription')}</p>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {presentation === 'ringing' ? (
              <>
                <button className="admin-button admin-button-secondary" disabled={pending} onClick={onDecline} type="button">
                  {t('incomingCall.decline')}
                </button>
                {nativeShell ? (
                  <button className="admin-button admin-button-primary" disabled={pending} onClick={onAccept} type="button">
                    {t('incomingCall.accept')}
                  </button>
                ) : (
                  <a
                    className="admin-button admin-button-primary"
                    href={call.meetingUri}
                    onClick={onAccept}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {t('incomingCall.accept')}
                  </a>
                )}
              </>
            ) : (
              <>
                <button className="admin-button admin-button-secondary" onClick={onClose} type="button">{t('incomingCall.close')}</button>
                <ExternalJoinControl call={call} label={t('incomingCall.join')} onOpen={onJoin} />
              </>
            )}
          </div>
        </div>
      ) : null}
    </Dialog>
  )
}
