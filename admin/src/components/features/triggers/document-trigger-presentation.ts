import {
  DOCUMENT_TRIGGER_SKIP_SENTENCES,
  DocumentChangedStoredConfigSchema,
  DocumentTriggerDeliveryPayloadSchema,
  type DocumentTriggerKind,
} from '@nessie/schemas'

/**
 * How a `document_changed` trigger reads on the Schedules and triggers page: its one-line
 * summary in a list row, and what each delivery decided, in words
 * (docs/plans/2026-09-23-ticket-driven-agents/triggers.md → "`document_changed`").
 * A delivery carries metadata only — never the document or its title — so the
 * line names versions, not text.
 */

/** "3 min", "45 s", "1 h 30 min": the quiet window as a person says it. */
export const formatQuietWindow = (seconds: number): string => {
  if (seconds < 60) return `${seconds} s`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return [hours ? `${hours} h` : null, minutes ? `${minutes} min` : null, rest ? `${rest} s` : null]
    .filter(Boolean)
    .join(' ')
}

/** "documents and files", "documents", "files". */
export const documentKindsWord = (kinds: readonly DocumentTriggerKind[]): string =>
  kinds.includes('document') && kinds.includes('file')
    ? 'documents and files'
    : kinds.includes('file') ? 'files' : 'documents'

/**
 * A document trigger in one line, from its stored (resolved) config. The space
 * and folder are ids there, and a list row knows no names, so it says what
 * kind of scope it is; the trigger's own page names them.
 */
export const getDocumentTriggerSummary = (config: unknown): string => {
  const parsed = DocumentChangedStoredConfigSchema.safeParse(config)
  if (!parsed.success) return 'Configuration needs attention'
  const { fireOn, folderPageId, kinds, labels, pageIds, quietSeconds } = parsed.data
  const scope = pageIds
    ? `${pageIds.length} chosen ${pageIds.length === 1 ? 'page' : 'pages'}`
    : `${folderPageId ? 'a folder’s' : 'a space’s'} ${documentKindsWord(kinds)}`
  const labelled = labels ? ` labelled ${labels.join(' or ')}` : ''
  return `Reviews each ${fireOn} of ${scope}${labelled}, after ${formatQuietWindow(quietSeconds)} quiet`
}

/**
 * A document delivery on a trigger's page: what the dispatcher did with one
 * quiet window. Null for any other trigger's payload, which keeps its raw
 * payload view.
 */
export const documentDeliveryLine = (payload: unknown): string | null => {
  const parsed = DocumentTriggerDeliveryPayloadSchema.safeParse(payload)
  if (!parsed.success) return null
  const delivery = parsed.data
  if (delivery.outcome === 'skipped' && delivery.skipReason) {
    return DOCUMENT_TRIGGER_SKIP_SENTENCES[delivery.skipReason]
  }
  const versions = delivery.fromVersionNumber
    ? `v${delivery.fromVersionNumber} → v${delivery.toVersionNumber}`
    : `v${delivery.toVersionNumber}`
  const saves = delivery.versionsCoalesced > 1 ? ` (${delivery.versionsCoalesced} saves)` : ''
  return delivery.outcome === 'ticket_work'
    ? `Woke the ticket’s work to review ${versions}${saves}.`
    : `Woke the agent to review ${versions}${saves} in the document’s thread.`
}
