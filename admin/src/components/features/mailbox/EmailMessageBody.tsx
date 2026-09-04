import { useMemo, useState } from 'react'
import type { ConnectedMailMessage, EmailMessageRecord } from '@nessie/schemas'

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
type RenderableMailMessage = EmailMessageRecord | ConnectedMailMessage

const bodyOf = (message: RenderableMailMessage): { html: string | null; text: string } => {
  if ('bodyFormat' in message) {
    return { html: message.bodyFormat === 'html' ? message.body : null, text: message.bodyFormat === 'text' ? message.body : '' }
  }
  return { html: message.htmlBody, text: message.textBody }
}

export const EmailMessageBody = ({ message }: { message: RenderableMailMessage }) => {
  const [imagesLoaded, setImagesLoaded] = useState(false)
  const body = bodyOf(message)

  const hasBlockedImages = useMemo(
    () => Boolean(body.html?.includes('data-blocked-src=')),
    [body.html],
  )

  const html = useMemo(() => {
    if (!body.html) return null
    if (!imagesLoaded) return body.html
    // The reveal is a rename, not a re-parse: the sanitizer already decided
    // which URLs were allowed to exist at all.
    return body.html.replaceAll('data-blocked-src=', 'src=')
  }, [body.html, imagesLoaded])

  if (!html) {
    return (
      <p className="whitespace-pre-wrap text-sm text-[color:var(--tx2)]">{body.text}</p>
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
