import { attachmentPath } from '../../../lib/uploads'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { Dialog } from '../../shared/Dialog'
import { RetryableTextFilePreview } from '../../shared/TextFilePreview'
import { MessageMarkdown } from './MessageMarkdown'

/**
 * The verbatim call transcript, read in place.
 *
 * Deliberately not a link. The transcript is an attachment fetched with the
 * session token, which means a `blob:` URL — and a `blob:` URL inherits the
 * page origin, so following one replaces the SPA with the raw file and takes
 * the shell's navigation state with it (fixed in
 * `mobile/src/lib/call-external-url.ts`; top-level navigation to
 * page-created documents is blocked outright now). So the bytes are fetched
 * and rendered inside the admin's one centred modal instead, and nothing
 * navigates.
 *
 * The transcript is client-reported speech, so remote images are refused:
 * an `![](https://…)` in a line somebody spoke — or in a line a model
 * transcribed — must not phone home when the dialog opens.
 */
export type VoiceTranscriptDialogProps = {
  attachmentId: string
  onClose: () => void
  open: boolean
}

export const VoiceTranscriptDialog = ({
  attachmentId,
  onClose,
  open,
}: VoiceTranscriptDialogProps) => {
  const { token } = useAuthSession()

  return (
    // No `description`: the transcript file opens with its own header naming
    // the call, its duration and that it was transcribed on the device, so a
    // subtitle here would print the same sentence twice.
    <Dialog
      onClose={onClose}
      open={open}
      size="lg"
      title="Call transcript"
    >
      <div className="max-h-[70dvh] overflow-y-auto px-1 py-2">
        <RetryableTextFilePreview
          downloadPath={attachmentPath(attachmentId)}
          render={({ text, truncated }) => (
            <>
              <MessageMarkdown allowRemoteImages={false} renderInlineText={(inline) => inline}>
                {text}
              </MessageMarkdown>
              {truncated ? (
                <p className="mt-3 text-xs text-[color:var(--tx3)]">
                  …truncated — this call was long enough that the rest is in the
                  attached file.
                </p>
              ) : null}
            </>
          )}
          token={token}
        />
      </div>
    </Dialog>
  )
}
