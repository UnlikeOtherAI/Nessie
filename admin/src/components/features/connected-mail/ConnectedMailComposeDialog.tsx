import { useState } from 'react'
import type { ConnectedMailAccountRecord, ConnectedMailMessage } from '@nessie/schemas'

import { useNavigationLayout } from '../../../navigation/mobile-shell'
import { Dialog } from '../../shared/Dialog'
import {
  ConnectedMailCompose,
  type MailComposeDraft,
} from './ConnectedMailCompose'
import type { MailAddress } from '../../../facades/mail/hooks'

type ConnectedMailComposeDialogProps = {
  account: ConnectedMailAccountRecord
  address: MailAddress
  composeId?: string
  gmailDraftId?: string
  initialDraft?: MailComposeDraft
  newCompose?: boolean
  onClose: () => void
  onNewComposeReady?: () => void
  onOpenSettings: () => void
  onSent: () => void
  onStartNewEmail?: (composeId: string) => void
  open: boolean
  replyTo?: ConnectedMailMessage
}

/**
 * The one compose dialog used by chat doorways and claimed chat-card drafts.
 * It mounts the canonical composer once; maximize only changes the shared
 * dialog shell, so typed fields remain mounted through both transitions.
 */
export const ConnectedMailComposeDialog = ({
  account,
  address,
  composeId,
  gmailDraftId,
  initialDraft,
  newCompose,
  onClose,
  onNewComposeReady,
  onOpenSettings,
  onSent,
  onStartNewEmail,
  open,
  replyTo,
}: ConnectedMailComposeDialogProps) => {
  const layout = useNavigationLayout()
  const [maximized, setMaximized] = useState(false)
  const full = layout === 'single' || maximized

  return (
    <Dialog
      description="Mail access is checked when this opens."
      headerActions={layout !== 'single' ? (
        <button
          aria-label={maximized ? 'Restore email composer' : 'Maximize email composer'}
          className="admin-button admin-button-secondary admin-button-compact"
          data-testid={maximized ? 'mail-compose-dialog-restore' : 'mail-compose-dialog-maximize'}
          onClick={() => setMaximized((current) => !current)}
          type="button"
        >
          {maximized ? 'Restore' : 'Maximize'}
        </button>
      ) : undefined}
      onClose={onClose}
      open={open}
      size={full ? 'full' : 'xl'}
      title="Compose email"
    >
      <div
        className="min-h-0 p-4"
        data-fullscreen={maximized ? 'true' : 'false'}
        data-testid="connected-mail-compose-dialog"
      >
        <ConnectedMailCompose
          account={account}
          address={address}
          composeId={composeId}
          gmailDraftId={gmailDraftId}
          initialDraft={initialDraft}
          newCompose={newCompose}
          onNewComposeReady={onNewComposeReady}
          onOpenSettings={onOpenSettings}
          onSent={onSent}
          onStartNewEmail={onStartNewEmail}
          replyTo={replyTo}
        />
      </div>
    </Dialog>
  )
}
