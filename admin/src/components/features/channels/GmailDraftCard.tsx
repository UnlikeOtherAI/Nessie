import { useState } from 'react'
import { Pill } from '../../primitives/Pill'
import {
  useDiscardGmailDraft,
  useGmailDraft,
  useSendGmailDraft,
  useUndoGmailSend,
} from '../../../facades/gmail/hooks'

/**
 * The email draft card.
 *
 * Rendered from message metadata `{ card: { kind: 'gmail_draft', draftActionId } }`,
 * which is server-authored and carries IDENTIFIERS ONLY. Recipients, subject
 * and body are fetched from an owner-gated route that answers an
 * indistinguishable 404 to anybody else — message metadata is readable by
 * everyone who can read the message, so putting the subject line there would
 * leak the one thing this is meant to protect.
 *
 * Two action modes share this one component: a person acting on their own
 * draft, and an approver resolving an agent's request to send it.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const readGmailDraftCard = (
  metadata: Record<string, unknown> | undefined,
): { draftActionId: string } | null => {
  const card = metadata?.card
  if (!isRecord(card) || card.kind !== 'gmail_draft') return null
  const draftActionId = card.draftActionId
  return typeof draftActionId === 'string' ? { draftActionId } : null
}

const AddressRow = ({ label, values }: { label: string; values: string[] }) =>
  values.length === 0 ? null : (
    <div className="flex gap-2 text-xs">
      <span className="w-10 shrink-0 text-[color:var(--tx3)]">{label}</span>
      <span className="min-w-0 break-words text-[color:var(--tx)]">
        {values.join(', ')}
      </span>
    </div>
  )

export const GmailDraftCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const card = readGmailDraftCard(metadata)
  const draft = useGmailDraft(card?.draftActionId ?? null)
  const send = useSendGmailDraft()
  const undo = useUndoGmailSend()
  const discard = useDiscardGmailDraft()
  const [error, setError] = useState<string | null>(null)

  if (!card) return null

  // A viewer who is not the mailbox owner gets a 404 by design. Show nothing
  // rather than an empty shell that advertises a draft they cannot see.
  if (draft.isError) return null
  if (!draft.data) {
    return (
      <div className="mt-2 max-w-2xl rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3 text-xs text-[color:var(--tx3)]">
        Loading draft…
      </div>
    )
  }

  const data = draft.data
  const busy = send.isPending || undo.isPending || discard.isPending
  const act = async (run: () => Promise<unknown>, message: string) => {
    setError(null)
    try {
      await run()
    } catch {
      setError(message)
    }
  }

  return (
    <div
      className="mt-2 max-w-2xl rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3"
      data-testid="gmail-draft-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase text-[color:var(--tx3)]">
          Email draft
        </span>
        {data.state === 'sent' ? (
          <Pill radius="chip" size="sm" tone="success" uppercase={false}>
            Sent
          </Pill>
        ) : data.state === 'sending' ? (
          <Pill radius="chip" size="sm" tone="warning" uppercase={false}>
            Sending…
          </Pill>
        ) : data.state === 'discarded' ? (
          <Pill radius="chip" size="sm" tone="muted" uppercase={false}>
            Discarded
          </Pill>
        ) : null}
      </div>

      <div className="mt-2 grid gap-1">
        <AddressRow label="To" values={data.to} />
        <AddressRow label="Cc" values={data.cc} />
        <AddressRow label="Bcc" values={data.bcc} />
      </div>

      <div className="mt-2 text-sm font-semibold text-[color:var(--tx)]">
        {data.subject || '(no subject)'}
      </div>
      <div className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-2 text-xs leading-5 text-[color:var(--tx2)]">
        {data.body}
      </div>

      {data.attachments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {data.attachments.map((attachment) => (
            <span
              className="rounded border border-[color:var(--sep)] px-2 py-0.5 text-[11px] text-[color:var(--tx2)]"
              key={attachment.filename}
            >
              {attachment.filename}
            </span>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-[11px] text-[color:var(--danger-text)]">{error}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {data.state === 'draft' ? (
          <>
            <button
              className="admin-button admin-button-primary"
              data-testid="gmail-draft-send"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    send.mutateAsync({
                      id: card.draftActionId,
                      // Send back exactly what this card rendered, so a draft
                      // that changed since is refused rather than delivered.
                      expectedFingerprint: data.contentFingerprint,
                    }),
                  'Could not send. The draft may have changed — reload and check it.',
                )
              }
              type="button"
            >
              {send.isPending ? 'Sending…' : 'Send'}
            </button>
            <button
              className="admin-button admin-button-secondary admin-button-danger"
              disabled={busy}
              onClick={() =>
                void act(
                  () => discard.mutateAsync(card.draftActionId),
                  'Could not discard the draft.',
                )
              }
              type="button"
            >
              Discard
            </button>
          </>
        ) : null}

        {data.state === 'sending' ? (
          <button
            className="admin-button admin-button-secondary"
            data-testid="gmail-draft-undo"
            disabled={busy}
            onClick={() =>
              void act(
                () => undo.mutateAsync(card.draftActionId),
                'Too late to undo — the email has gone.',
              )
            }
            type="button"
          >
            Undo
          </button>
        ) : null}
      </div>
    </div>
  )
}
