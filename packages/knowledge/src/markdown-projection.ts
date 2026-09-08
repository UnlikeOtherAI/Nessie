import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false })

export const MARKDOWN_IMPORT_MAX_BYTES = 5 * 1024 * 1024

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx'])

export const isMarkdownFilename = (filename: string): boolean => {
  const extension = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined
  return extension ? MARKDOWN_EXTENSIONS.has(extension) : false
}

export const isMarkdownAttachment = (attachment: { filename: string; mime: string }): boolean =>
  isMarkdownFilename(attachment.filename)
  || attachment.mime === 'text/markdown'
  || attachment.mime === 'text/x-markdown'

export const markdownToHtml = (source: string): string => markdown.render(source)

export type MarkdownAttachmentReader = (
  attachmentId: string,
  organizationId: string,
) => Promise<Readable | null>

export type MarkdownProjection = {
  body: string
  sourceContentHash: string
}

export type CanonicalMarkdownSource = {
  content: string
  sourceContentHash: string
}

const readCappedUtf8 = async (stream: Readable): Promise<{ bytes: Buffer; text: string }> => {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += bytes.length
    if (total > MARKDOWN_IMPORT_MAX_BYTES) {
      stream.destroy()
      throw new Error('Markdown document exceeds the import limit')
    }
    chunks.push(bytes)
  }
  const bytes = Buffer.concat(chunks)
  return { bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
}

/**
 * Produces the only writable body projection for a Markdown attachment.
 *
 * The caller receives a stream from FileService, never a caller-provided text
 * value, so attachment bytes remain the authority for the rendered body,
 * chunks, and source digest.
 */
export const readCanonicalMarkdownAttachment = async (
  readAttachment: MarkdownAttachmentReader,
  attachmentId: string,
  organizationId: string,
): Promise<CanonicalMarkdownSource> => {
  const stream = await readAttachment(attachmentId, organizationId)
  if (!stream) throw new Error('Markdown attachment bytes not found')
  const { bytes, text } = await readCappedUtf8(stream)
  return {
    content: text,
    sourceContentHash: createHash('sha256').update(bytes).digest('hex'),
  }
}

export const projectMarkdownAttachment = async (
  readAttachment: MarkdownAttachmentReader,
  attachmentId: string,
  organizationId: string,
): Promise<MarkdownProjection> => {
  const source = await readCanonicalMarkdownAttachment(readAttachment, attachmentId, organizationId)
  return { body: markdownToHtml(source.content), sourceContentHash: source.sourceContentHash }
}
