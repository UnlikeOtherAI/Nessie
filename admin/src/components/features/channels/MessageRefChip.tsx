import { MessageRefMetadataSchema } from '@nessie/schemas'
import { useFeedMessageRefs } from './feed-message-refs'

const readMessageRef = (metadata: Record<string, unknown> | undefined): string | null => {
  const parsed = MessageRefMetadataSchema.safeParse(metadata?.messageRef)
  return parsed.success ? parsed.data.messageId : null
}

/**
 * The link from a one-on-one reply back to the earlier message it is about
 * (`metadata.messageRef`, written by the server from Jev's plan —
 * docs/standards/reply-threads.md → "One-on-one rooms").
 *
 * It shows that message the way the reader's own feed has it, never a copy
 * kept on the reply, and takes them there: a scroll and a flash when the feed
 * has it loaded, otherwise the earlier message's reply panel, which opens on
 * the message itself.
 */
export const MessageRefChip = ({
  metadata,
  onOpenThread,
}: {
  metadata: Record<string, unknown> | undefined
  onOpenThread?: (rootMessageId: string) => void
}) => {
  const refs = useFeedMessageRefs()
  const messageId = readMessageRef(metadata)
  if (!messageId) return null

  const earlier = refs?.find(messageId) ?? null
  const jumpTo = refs?.jumpTo
  const open = earlier && jumpTo
    ? () => jumpTo(messageId)
    : onOpenThread
      ? () => onOpenThread(messageId)
      : null
  const label = (
    <>
      <span aria-hidden="true" className="flex-shrink-0 text-[color:var(--tx3)]">↩</span>
      <span className="min-w-0">
        <span className="block font-semibold text-[var(--tx)]">
          {earlier?.authorName ?? 'Earlier message'}
        </span>
        {earlier?.excerpt ? (
          <span className="block truncate text-[color:var(--tx3)]">{earlier.excerpt}</span>
        ) : null}
      </span>
    </>
  )
  const className = [
    'mb-1.5 flex w-full max-w-md items-start gap-2 rounded-lg border border-[color:var(--sep)]',
    'bg-[var(--overlay-weak)] px-2.5 py-1.5 text-left text-xs text-[color:var(--tx2)]',
  ].join(' ')

  return open ? (
    <button
      aria-label={`Go to the earlier message${earlier ? ` from ${earlier.authorName}` : ''}`}
      className={`${className} transition-colors hover:bg-[color:var(--main-hover)]`}
      data-testid="message-ref-chip"
      onClick={(event) => {
        event.stopPropagation()
        open()
      }}
      type="button"
    >
      {label}
    </button>
  ) : (
    <div className={className} data-testid="message-ref-chip">{label}</div>
  )
}
