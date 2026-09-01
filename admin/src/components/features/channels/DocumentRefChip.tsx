import { Link } from 'react-router-dom'
import { DocumentRefMetadataSchema, type DocumentRefMetadata } from '@nessie/schemas'

const readDocumentRef = (
  metadata: Record<string, unknown> | undefined,
): DocumentRefMetadata | null => {
  const parsed = DocumentRefMetadataSchema.safeParse(metadata?.documentRef)
  return parsed.success ? parsed.data : null
}

/**
 * The durable doorway to a document an agent wrote in this conversation. The
 * popup closes; the message stays, so `metadata.documentRef` (server-authored,
 * the `metadata.runStop` precedent — never written from model output) is what
 * makes the saved file reachable a week later, from the place the work happened.
 */
export const DocumentRefChip = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const documentRef = readDocumentRef(metadata)
  if (!documentRef) {
    return null
  }

  return (
    <div className="mt-2">
      <Link
        className={[
          'inline-flex max-w-full items-center gap-2 rounded-lg border border-[color:var(--sep)]',
          'bg-[var(--overlay-weak)] px-3 py-1.5 text-xs text-[color:var(--tx2)]',
          'transition-colors hover:bg-[color:var(--main-hover)]',
        ].join(' ')}
        data-testid="document-ref-chip"
        to={
          `/knowledge-base?spaceId=${encodeURIComponent(documentRef.spaceId)}` +
          `&pageId=${encodeURIComponent(documentRef.pageId)}`
        }
      >
        <span aria-hidden="true">📄</span>
        <span className="min-w-0 truncate font-semibold text-[var(--tx)]">
          {documentRef.title}
        </span>
        <span className="flex-shrink-0 text-[color:var(--tx3)]">
          {documentRef.published ? 'Open document' : 'Draft — open'}
        </span>
      </Link>
    </div>
  )
}
