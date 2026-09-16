/**
 * Which uploads are worth deterministic text extraction, in one place.
 *
 * This predicate used to exist twice — once in the API route, to avoid
 * enqueuing dead-end `knowledge.extract` jobs, and once in the worker, as a
 * defensive re-check of a job that an older build (or a hand insert) may have
 * enqueued. Keeping the two copies in step was a comment, not a mechanism, and
 * a third reader now needs the same answer: the Finder row says "Not indexed —
 * unsupported" out loud, so a drift between the copies would make the screen
 * lie about a file that is in fact being indexed.
 *
 * The worker keeps its defensive re-check. It just re-checks against this
 * function instead of against a second list.
 *
 * Markdown never reaches this predicate: `knowledge-base-files.ts`
 * short-circuits it into a native document before a file-node page exists.
 */

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export const EXTRACTABLE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm', 'css',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'php', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'kt', 'sh', 'bash', 'sql', 'toml', 'ini',
  'log', 'env', 'conf', 'properties',
])

/** How the extract job must read an upload's bytes, or that it must not. */
export type ExtractKind = 'text' | 'pdf' | 'docx' | 'unsupported'

const extensionOf = (filename: string): string | undefined =>
  filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined

export const classifyUpload = (filename: string, mime: string): ExtractKind => {
  const ext = extensionOf(filename)
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime === DOCX_MIME || ext === 'docx') return 'docx'
  if (mime.startsWith('text/') || (ext !== undefined && EXTRACTABLE_TEXT_EXTENSIONS.has(ext))) {
    return 'text'
  }
  return 'unsupported'
}

export const isExtractableUpload = (filename: string, mime: string): boolean =>
  classifyUpload(filename, mime) !== 'unsupported'
