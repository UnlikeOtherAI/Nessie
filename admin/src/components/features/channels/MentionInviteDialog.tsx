import { useRef } from 'react'

import { Dialog } from '../../shared/Dialog'
import type { MentionInviteController, MentionInvitePrompt } from './useMentionInviteGate'

const joinNames = (names: string[]): string =>
  names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/** The question's words, kept apart from the shell so they can be read in a test. */
export const mentionInviteCopy = (prompt: MentionInvitePrompt) => {
  const names = joinNames(prompt.outsiders.map((person) => person.displayName))
  const plural = prompt.outsiders.length > 1
  return {
    title: `Invite ${plural ? 'them' : names} to #${prompt.channelLabel}?`,
    body: `${names} ${plural ? 'are' : 'is'} not in #${prompt.channelLabel} and can't see it. `
      + 'Inviting adds them to the channel, including its history.',
    withoutInvite: 'If you send without inviting, they won\'t be notified and won\'t see the message.',
    refusal: prompt.canInvite
      ? null
      : 'You can\'t add people to this channel. Ask one of its members to invite them.',
  }
}

export const MentionInviteDialogBody = ({
  controller,
  prompt,
}: {
  controller: MentionInviteController
  prompt: MentionInvitePrompt
}) => {
  const copy = mentionInviteCopy(prompt)
  return (
    <>
      <p className="text-sm text-[color:var(--tx2)]">{copy.body}</p>
      <p className="mt-2 text-sm text-[color:var(--tx3)]">{copy.withoutInvite}</p>
      {copy.refusal ? (
        <p className="mt-3 text-sm text-[color:var(--tx2)]" data-testid="mention-invite-refusal">
          {copy.refusal}
        </p>
      ) : null}
      {controller.error ? (
        <p className="mt-3 text-sm text-[color:var(--danger)]" role="alert">
          {controller.error}
        </p>
      ) : null}
    </>
  )
}

/**
 * Asked before a draft that @mentions people who cannot read a private or
 * protected channel is sent. Focus opens on Cancel: inviting hands over the
 * channel's history, so it is never completable by pressing Enter on arrival.
 */
export const MentionInviteDialog = ({ controller }: { controller: MentionInviteController }) => {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const { prompt, pending } = controller
  if (!prompt) return null
  const copy = mentionInviteCopy(prompt)

  return (
    <Dialog
      dismissDisabled={pending}
      initialFocusRef={cancelRef}
      onClose={controller.onCancel}
      open
      title={copy.title}
    >
      <MentionInviteDialogBody controller={controller} prompt={prompt} />
      <div className="flex flex-wrap justify-end gap-2 pt-5">
        <button
          ref={cancelRef}
          className="admin-button admin-button-secondary"
          data-testid="mention-invite-cancel"
          disabled={pending}
          onClick={controller.onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          className="admin-button admin-button-secondary"
          data-testid="mention-invite-send-without"
          disabled={pending}
          onClick={controller.onSendWithoutInviting}
          type="button"
        >
          Send without inviting
        </button>
        {prompt.canInvite ? (
          <button
            className="admin-button admin-button-primary"
            data-testid="mention-invite-confirm"
            disabled={pending}
            onClick={controller.onInviteAndSend}
            type="button"
          >
            {pending ? 'Inviting…' : 'Invite and send'}
          </button>
        ) : null}
      </div>
    </Dialog>
  )
}
