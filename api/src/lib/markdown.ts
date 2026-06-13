import type { Readable } from 'node:stream'
import MarkdownIt from 'markdown-it'

// Markdown files are the KB's native document format: an uploaded `.md` is
// imported into a real document (rendered + editable) rather than left as a raw
// file blob. `html: false` escapes any raw HTML in the source; the document
// reader/editor (tiptap) further sanitises by parsing through its schema.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false })

// Cap how much we read into memory when importing a markdown document — real
// markdown notes are tiny; anything larger stays a regular file blob.
export const MARKDOWN_IMPORT_MAX_BYTES = 5 * 1024 * 1024

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])

export const isMarkdownFilename = (filename: string): boolean => {
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined
  return ext ? MARKDOWN_EXTENSIONS.has(ext) : false
}

export const isMarkdownUpload = (filename: string, mime: string): boolean =>
  isMarkdownFilename(filename) || mime === 'text/markdown' || mime === 'text/x-markdown'

export const markdownToHtml = (markdown: string): string => md.render(markdown)

// Drop the extension from a filename for use as a document title (report.md → report).
export const filenameToTitle = (filename: string): string =>
  filename.replace(/\.[^./\\]+$/, '') || filename

// Read a stream into a buffer, bailing (null) once it exceeds `maxBytes` so a
// huge "markdown" upload can't blow up memory.
export const readStreamCapped = async (
  stream: Readable,
  maxBytes: number,
): Promise<Buffer | null> => {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > maxBytes) {
      stream.destroy()
      return null
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}
