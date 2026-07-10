import { createHash } from 'node:crypto'
import { RecursiveChunker } from '@chonkiejs/core'
import { htmlToPlainText } from '@nessie/schemas'

export const DEFAULT_KNOWLEDGE_CHUNK_SIZE = 1600
export const DEFAULT_MIN_CHUNK_CHARACTERS = 240

export type KnowledgePageChunkDraft = {
  chunkIndex: number
  content: string
  contentHash: string
  endOffset: number
  startOffset: number
  tokenCount: number
}

export type ChunkKnowledgePageBodyOptions = {
  chunkSize?: number
  minCharactersPerChunk?: number
}

type ChunkerKey = `${number}:${number}`

const chunkers = new Map<ChunkerKey, Promise<RecursiveChunker>>()

const chunkerFor = (
  chunkSize: number,
  minCharactersPerChunk: number,
): Promise<RecursiveChunker> => {
  const key: ChunkerKey = `${chunkSize}:${minCharactersPerChunk}`
  const existing = chunkers.get(key)
  if (existing) return existing
  const created = RecursiveChunker.create({
    chunkSize,
    minCharactersPerChunk,
  })
  chunkers.set(key, created)
  return created
}

const contentHash = (content: string): string =>
  createHash('sha256').update(content).digest('hex')

const trimChunk = (input: {
  endIndex: number
  plainText: string
  searchFrom: number
  startIndex: number
  text: string
  tokenCount: number
}): Omit<KnowledgePageChunkDraft, 'chunkIndex' | 'contentHash'> | null => {
  const leadingWhitespace = input.text.match(/^\s*/)?.[0].length ?? 0
  const trailingWhitespace = input.text.match(/\s*$/)?.[0].length ?? 0
  const content = input.text.trim()
  if (!content) return null
  const anchoredStart = input.plainText.indexOf(
    content,
    Math.max(0, Math.min(input.searchFrom, input.startIndex)),
  )
  if (anchoredStart >= 0) {
    return {
      content,
      endOffset: anchoredStart + content.length,
      startOffset: anchoredStart,
      tokenCount: input.tokenCount,
    }
  }
  return {
    content,
    endOffset: input.endIndex - trailingWhitespace,
    startOffset: input.startIndex + leadingWhitespace,
    tokenCount: input.tokenCount,
  }
}

export const chunkKnowledgePageBody = async (
  htmlBody: string | null,
  options: ChunkKnowledgePageBodyOptions = {},
): Promise<KnowledgePageChunkDraft[]> => {
  const plainText = htmlToPlainText(htmlBody ?? '')
  if (!plainText) return []
  const chunker = await chunkerFor(
    options.chunkSize ?? DEFAULT_KNOWLEDGE_CHUNK_SIZE,
    options.minCharactersPerChunk ?? DEFAULT_MIN_CHUNK_CHARACTERS,
  )
  const rawChunks = await chunker.chunk(plainText)
  const chunks: Array<Omit<KnowledgePageChunkDraft, 'chunkIndex' | 'contentHash'>> = []
  let searchFrom = 0
  for (const rawChunk of rawChunks) {
    const chunk = trimChunk({ ...rawChunk, plainText, searchFrom })
    if (!chunk) continue
    chunks.push(chunk)
    searchFrom = chunk.endOffset
  }

  return chunks
    .map((chunk, index) => ({
      ...chunk,
      chunkIndex: index,
      contentHash: contentHash(chunk.content),
    }))
}
