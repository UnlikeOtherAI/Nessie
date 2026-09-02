import { useMemo, useState } from 'react'
import type { EmailMessageRecord } from '@nessie/schemas'

/**
 * One email's body.
 *
 * The HTML arrives already sanitized — that happens once at ingest, in
 * `@nessie/agent-mail`, so every reader gets the safe form and no future
 * surface has to remember to sanitize. What is left for the client is the
 * *remote content* decision: a remote image in an email is a tracking pixel by
 * default, telling the sender the message was opened, by whom and when. Ingest
 * parks those URLs on `data-blocked-src`, and nothing fetches them until the
 * person reading asks — per message, never as a standing setting.
 */
export const EmailMessageBody = ({ message }: { message: EmailMessageRecord }) => {
  const [imagesLoaded, setImagesLoaded] = useState(false)

  const hasBlockedImages = useMemo(
    () => Boolean(message.htmlBody?.includes('data-blocked-src=')),
    [message.htmlBody],
  )

  const html = useMemo(() => {
    if (!message.htmlBody) return null
    if (!imagesLoaded) return message.htmlBody
    // The reveal is a rename, not a re-parse: the sanitizer already decided
    // which URLs were allowed to exist at all.
    return message.htmlBody.replaceAll('data-blocked-src=', 'src=')
  }, [imagesLoaded, message.htmlBody])

  if (!html) {
    return (
      <p className="whitespace-pre-wrap text-sm text-[color:var(--tx2)]">{message.textBody}</p>
    )
  }

  return (
    <div>
      {hasBlockedImages && !imagesLoaded && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-[var(--surface-2)] px-3 py-2 text-xs text-[color:var(--tx3)]">
          <span>Remote images are blocked so the sender cannot tell you opened this.</span>
          <button
            className="underline"
            onClick={() => setImagesLoaded(true)}
            type="button"
          >
            Load images
          </button>
        </div>
      )}
      <div
        className="email-body text-sm text-[color:var(--tx2)]"
        // Sanitized at ingest by the one parser, with scripts, handlers and
        // unsafe URL schemes removed; this renders the stored safe form.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
