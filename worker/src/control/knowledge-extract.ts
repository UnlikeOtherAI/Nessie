import { createRequire } from 'node:module'
import type { Readable } from 'node:stream'
import type { PrismaClient } from '@prisma/client'
import type { FileService } from '@nessie/runtime'
import { replaceKnowledgePageVersionChunks } from '@nessie/knowledge'
import { KNOWLEDGE_EMBED_TOPIC, type KnowledgeExtractJobPayload } from '@nessie/schemas'
import mammoth from 'mammoth'
import { enqueueQueueJob } from '../queue.js'

// pdf-parse@1.1.1's package root (index.js) runs a debug self-test whenever
// `!module.parent` — which is always true when a CJS module is pulled in via
// an ESM `import` (there is no CJS parent module object in that case), so a
// plain `import pdfParse from 'pdf-parse'` throws ENOENT reading its own test
// fixture on every load. `createRequire` gives it a real CJS parent, which is
// the standard Node-documented way to load a CJS package from ESM and the
// only thing that avoids the bug (verified in worker/test/knowledge-extract.test.ts).
const require = createRequire(import.meta.url)
const pdfParseLib = require('pdf-parse') as (
  buffer: Buffer,
) => Promise<{ text: string }>

// `knowledge.extract` worker handler — deterministic text extraction for
// uploaded file-node pages/versions (api/src/routes/knowledge-base-files.ts),
// the first stage of the file pipeline:
//   extract (this job) -> chunk (same transaction, below) -> knowledge.embed
//   (enqueued only when chunks were actually written).
// Markdown never reaches this job — it is imported as a native document
// upstream, before a file-node page exists.

// Bounds memory/CPU: pdf/docx parsers need the whole blob buffered, so a hard
// byte cap on the source attachment keeps that bounded regardless of kind.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
// Bounds how much plain text ever reaches the chunker, independent of the
// source attachment's byte size (a 20 MiB plain-text file still has far more
// than 500k characters worth of useful index content).
const MAX_EXTRACTED_CHARS = 500_000
const TEXT_STREAM_MAX_BYTES = MAX_EXTRACTED_CHARS * 4

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const EXTRACTABLE_TEXT_EXTENSIONS = new Set([
  'txt', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm', 'css',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'php', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'kt', 'sh', 'bash', 'sql', 'toml', 'ini',
  'log', 'env', 'conf', 'properties',
])

type ExtractKind = 'text' | 'pdf' | 'docx' | 'unsupported'

const extensionOf = (filename: string): string | undefined =>
  filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined

// Mirrors api/src/routes/knowledge-base-file-extract.ts's isExtractableUpload —
// deliberately re-checked here (defense in depth: a job enqueued by an older
// api build, or hand-inserted, still gets judged before any bytes are read).
const classifyUpload = (filename: string, mime: string): ExtractKind => {
  const ext = extensionOf(filename)
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime === DOCX_MIME || ext === 'docx') return 'docx'
  if (mime.startsWith('text/') || (ext !== undefined && EXTRACTABLE_TEXT_EXTENSIONS.has(ext))) {
    return 'text'
  }
  return 'unsupported'
}

const normalizeExtractedText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_EXTRACTED_CHARS)

const readStreamFully = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

// Plain-text sources can be arbitrarily long even under the byte cap (a dense
// 20 MiB text file is nowhere near 500k characters), so stop reading as soon
// as enough bytes have accumulated to safely cover MAX_EXTRACTED_CHARS.
const readTextStreamCapped = async (stream: Readable): Promise<string> => {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    chunks.push(buf)
    total += buf.length
    if (total >= TEXT_STREAM_MAX_BYTES) {
      stream.destroy()
      break
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

// The pdf/docx parsers are injected (defaulting to the real libraries below)
// rather than called inline, so tests can exercise the pdf/docx branches —
// including buffer plumbing and text plumbing — without needing real PDF/DOCX
// binary fixtures or reaching for node module-resolution mocking.
export type PdfParser = (buffer: Buffer) => Promise<{ text: string }>
export type DocxTextExtractor = (buffer: Buffer) => Promise<{ value: string }>

const defaultParsePdf: PdfParser = (buffer) => pdfParseLib(buffer)
const defaultExtractDocxText: DocxTextExtractor = (buffer) => mammoth.extractRawText({ buffer })

const extractText = async (
  kind: ExtractKind,
  stream: Readable,
  parsers: { parsePdf: PdfParser; extractDocxText: DocxTextExtractor },
): Promise<string> => {
  if (kind === 'text') {
    return readTextStreamCapped(stream)
  }
  const buffer = await readStreamFully(stream)
  if (kind === 'pdf') {
    const parsed = await parsers.parsePdf(buffer)
    return parsed.text
  }
  // kind === 'docx'
  const result = await parsers.extractDocxText(buffer)
  return result.value
}

type KnowledgeExtractDeps = {
  fileService: FileService
  prisma: PrismaClient
  // Overridable for tests; defaults to the real pdf-parse/mammoth calls.
  parsePdf?: PdfParser
  extractDocxText?: DocxTextExtractor
}

const loggedSkips = new Set<string>()
const logSkipOnce = (key: string, message: string, details: Record<string, unknown>): void => {
  if (loggedSkips.has(key)) return
  loggedSkips.add(key)
  console.warn(`[worker.knowledge-extract] ${message}`, details)
}

export const executeKnowledgeExtractJob = async (
  deps: KnowledgeExtractDeps,
  payload: KnowledgeExtractJobPayload,
): Promise<void> => {
  const page = await deps.prisma.knowledgePage.findFirst({
    where: {
      id: payload.pageId,
      organizationId: payload.organizationId,
      kind: 'file',
      deletedAt: null,
    },
    select: {
      id: true,
      organizationId: true,
      projectId: true,
      teamId: true,
      channelId: true,
      threadId: true,
      userId: true,
      visibility: true,
      sensitivityTier: true,
      privateToAgentId: true,
      taskId: true,
    },
  })
  // Page deleted, or converted away from a file node, since the job was
  // enqueued — nothing left to index.
  if (!page) return

  const version = await deps.prisma.knowledgePageVersion.findFirst({
    where: { id: payload.versionId, pageId: payload.pageId },
    select: { attachmentId: true },
  })
  // A newer version has since superseded this one, or it was never a file
  // version — this stale job has nothing to extract.
  if (!version || version.attachmentId !== payload.attachmentId) return

  const attachment = await deps.prisma.attachment.findUnique({
    where: { id: payload.attachmentId },
  })
  if (!attachment || attachment.organizationId !== payload.organizationId) return

  const kind = classifyUpload(attachment.filename, attachment.mime)
  if (kind === 'unsupported') return

  if (Number(attachment.sizeBytes) > MAX_ATTACHMENT_BYTES) {
    logSkipOnce(`${payload.pageId}:${payload.versionId}`, 'skipping oversized attachment', {
      attachmentId: payload.attachmentId,
      pageId: payload.pageId,
      sizeBytes: attachment.sizeBytes.toString(),
    })
    return
  }

  const opened = await deps.fileService.openStream(payload.attachmentId, payload.organizationId)
  if (!opened) return

  const rawText = await extractText(kind, opened.stream, {
    parsePdf: deps.parsePdf ?? defaultParsePdf,
    extractDocxText: deps.extractDocxText ?? defaultExtractDocxText,
  })
  const text = normalizeExtractedText(rawText)
  if (!text) return

  await deps.prisma.$transaction(async (tx) => {
    // Canonical chunk writer (idempotent per append-only version) — passing
    // extracted plain text as the body is correct: chunking runs its
    // htmlToPlainText projection, a no-op for plain text.
    const written = await replaceKnowledgePageVersionChunks(tx, {
      page,
      version: { body: text, id: payload.versionId },
    })
    if (!written) return
    await enqueueQueueJob(tx, {
      idempotencyKey: `kb-embed:${payload.pageId}:${payload.versionId}`,
      payload: {
        organizationId: payload.organizationId,
        origin: payload.origin,
        pageId: payload.pageId,
        versionId: payload.versionId,
      },
      topic: KNOWLEDGE_EMBED_TOPIC,
    })
  })
}
