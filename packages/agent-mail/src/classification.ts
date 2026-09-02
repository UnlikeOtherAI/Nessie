/**
 * Structural classification of inbound mail — RFC header facts only.
 *
 * This is deliberately NOT an interpretation of what a message says: the
 * repository rule is that meaning is the model's job, and a keyword list here
 * would be exactly the string-matched intent detection that rule forbids. What
 * these headers state is mechanical — "a machine sent this", "this is a mailing
 * list", "this is a delivery report" — and that mechanical fact is what decides
 * whether a run is worth spending, because answering a bounce notice with a
 * generated reply is how mail loops start.
 *
 * `bulk` and `dsn` mail is still stored and still shown in the mailbox. It just
 * does not wake the agent.
 */

export type EmailClassification = 'normal' | 'bulk' | 'dsn'

export type HeaderLookup = (name: string) => string | undefined

export type ClassificationInput = {
  header: HeaderLookup
  /** SMTP envelope MAIL FROM. An empty return-path is the DSN signature. */
  envelopeFrom?: string | null
  contentType?: string | null
}

const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk'])

export const classifyInboundEmail = (input: ClassificationInput): EmailClassification => {
  const { header } = input

  // ── Delivery status notifications ────────────────────────────────────────
  // A null return-path (`MAIL FROM:<>`) is the RFC 5321 §4.5.5 signature of a
  // notification that must never itself be answered; the multipart/report
  // content types are RFC 6522.
  const envelopeFrom = input.envelopeFrom?.trim()
  if (envelopeFrom === '' || envelopeFrom === '<>') return 'dsn'
  const returnPath = header('return-path')?.trim()
  if (returnPath === '<>' || returnPath === '') return 'dsn'
  const contentType = (input.contentType ?? header('content-type') ?? '').toLowerCase()
  if (
    contentType.includes('report-type=delivery-status')
    || contentType.includes('report-type=disposition-notification')
    || contentType.includes('message/delivery-status')
  ) {
    return 'dsn'
  }
  if (header('auto-submitted')?.toLowerCase().trim() === 'auto-replied') return 'dsn'

  // ── Automated and bulk mail ──────────────────────────────────────────────
  // RFC 3834: anything other than `no` means a machine generated it.
  const autoSubmitted = header('auto-submitted')?.toLowerCase().trim()
  if (autoSubmitted && autoSubmitted !== 'no') return 'bulk'
  if (header('list-id') || header('list-unsubscribe')) return 'bulk'
  const precedence = header('precedence')?.toLowerCase().trim()
  if (precedence && BULK_PRECEDENCE.has(precedence)) return 'bulk'
  // Microsoft's and Google's equivalents of Auto-Submitted.
  if (header('x-auto-response-suppress')) return 'bulk'
  if (header('x-autoreply') || header('x-autorespond')) return 'bulk'

  return 'normal'
}

/**
 * SES receipt verdicts. A failure here does not delete anything — the message is
 * stored and readable in the mailbox — but it must never autonomously wake an
 * agent, because the sender is unproven or the payload is hostile.
 */
export type ReceiptVerdicts = {
  spam?: string | null
  virus?: string | null
  spf?: string | null
  dkim?: string | null
  dmarc?: string | null
}

const FAILED = new Set(['fail', 'failed', 'softfail', 'error', 'processing_failed'])

export const verdictsBlockAutonomy = (verdicts: ReceiptVerdicts | null | undefined): boolean => {
  if (!verdicts) return false
  return [verdicts.spam, verdicts.virus, verdicts.spf, verdicts.dkim, verdicts.dmarc].some(
    (value) => Boolean(value) && FAILED.has(String(value).toLowerCase()),
  )
}

/**
 * The single structural question the inbound pipeline asks before spending a
 * run: does this message wake the agent at all?
 */
export const shouldWakeAgent = (input: {
  classification: EmailClassification
  verdicts?: ReceiptVerdicts | null
}): boolean => input.classification === 'normal' && !verdictsBlockAutonomy(input.verdicts)
