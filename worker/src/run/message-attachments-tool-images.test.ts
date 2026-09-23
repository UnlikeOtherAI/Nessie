import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import type { FileService, ProviderMessage } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'

import {
  coverProviderInputComponent,
  finalizeProvenancedProviderInput,
} from './execute/provenanced-provider-input.js'
import { renderPromptImages, type ToolImageCache, type ToolImageSource } from './message-attachments.js'
import {
  buildToolImagesMessage,
  EARLIER_TOOL_IMAGES_TEXT,
  TOOL_IMAGES_INTRO,
  TOOL_IMAGES_NOT_SEEN_NOTE,
  type ToolImageRef,
} from './tool-images.js'

const ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000c1'
const RUN_ID = '00000000-0000-4000-8000-0000000000a1'
const OUR_COMMAND = '00000000-0000-4000-8000-0000000000b1'
const OTHER_RUNS_COMMAND = '00000000-0000-4000-8000-0000000000b2'

const idOf = (n: number): string => `0b7c6a8e-3f1d-4c2a-9e5b-7d8f9a0b1c${String(n).padStart(2, '0')}`
const ref = (n: number): ToolImageRef => ({ attachmentId: idOf(n), byteLength: 13_715, mimeType: 'image/png' })
const bytesOf = (n: number): Buffer => Buffer.from([0x89, 0x50, 0x4e, 0x47, n])

type StoredImage = { command?: string; mime?: string; sizeBytes?: bigint; thumbnailKey?: string | null }

/**
 * A run's attachments as the loader sees them: FileService for bytes, Prisma
 * for which of them belong to this run's own executor commands.
 */
const world = (stored: Record<number, StoredImage>) => {
  const reads: Array<{ id: string; source: 'original' | 'thumbnail' }> = []
  const lookups: string[][] = []
  const rowOf = (id: string) => {
    const n = Number(id.slice(-2))
    const image = stored[n]
    return image ? { n, image } : null
  }
  const open = (source: 'original' | 'thumbnail') => async (attachmentId: string, organizationId: string) => {
    reads.push({ id: attachmentId, source })
    const found = rowOf(attachmentId)
    if (!found || organizationId !== ORGANIZATION_ID) return null
    const data = source === 'original' ? bytesOf(found.n) : Buffer.from([0x52, 0x49, found.n])
    return { attachment: { mime: source === 'original' ? found.image.mime ?? 'image/png' : 'image/webp' }, stream: Readable.from([data]) }
  }
  const prisma = {
    attachment: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        lookups.push(where.id.in)
        return where.id.in.flatMap((id) => {
          const found = rowOf(id)
          return found ? [{
            executorCommandId: found.image.command ?? OUR_COMMAND,
            filename: `kelpie-screenshot-${found.n}.png`,
            id,
            kind: 'image',
            mime: found.image.mime ?? 'image/png',
            sizeBytes: found.image.sizeBytes ?? 13_715n,
            thumbnailKey: found.image.thumbnailKey === undefined ? 'key.thumb.webp' : found.image.thumbnailKey,
          }] : []
        })
      },
    },
    executorCommand: {
      findMany: async ({ where }: { where: { id: { in: string[] }; toolCall: { runId: string } } }) =>
        where.toolCall.runId === RUN_ID
          ? where.id.in.filter((id) => id === OUR_COMMAND).map((id) => ({ id }))
          : [],
    },
  }
  const source: ToolImageSource = {
    files: { openStream: open('original'), openThumbnailStream: open('thumbnail') } as unknown as FileService,
    organizationId: ORGANIZATION_ID,
    prisma: prisma as unknown as PrismaClient,
    runId: RUN_ID,
  }
  return { lookups, reads, source }
}

const toolTurn = (...ns: number[]): ProviderMessage =>
  coverProviderInputComponent(buildToolImagesMessage([{ imageRefs: ns.map(ref), toolName: 'executor_mcp_call' }])!, 'tool_images')

const covered = (message: ProviderMessage): ProviderMessage => coverProviderInputComponent(message, 'conversation')

const photo = (n: number) => ({ dataBase64: Buffer.from([n]).toString('base64'), mime: 'image/jpeg' })

const imagesOf = (message: ProviderMessage | undefined) =>
  message?.role === 'user' ? message.images ?? [] : []

test('a vision model sees a tool turn’s pictures, read from FileService, and nothing else of the turn', async () => {
  const { reads, source } = world({ 1: {} })
  const transcript = [covered({ content: 'Look at example.com', role: 'user' }), toolTurn(1)]
  const rendered = await renderPromptImages(transcript, source, { supportsVision: true })
  assert.deepEqual(imagesOf(rendered[1]), [{ dataBase64: bytesOf(1).toString('base64'), mime: 'image/png' }])
  assert.deepEqual(rendered[1], {
    content: `${TOOL_IMAGES_INTRO}\n[image 1: screenshot, 13 KB] from executor_mcp_call`,
    images: [{ dataBase64: bytesOf(1).toString('base64'), mime: 'image/png' }],
    role: 'user',
  }, 'the provider copy carries no references and no provenance field')
  assert.deepEqual(reads, [{ id: idOf(1), source: 'original' }])
  assert.equal(rendered[0], transcript[0], 'an unchanged turn is the same object')
  assert.equal((transcript[1] as { images?: unknown }).images, undefined, 'the transcript itself is untouched')
  // Local inference's provenance check accepts the rendered turn.
  assert.equal(finalizeProvenancedProviderInput(rendered).kind, 'ready')
})

test('an original over 4 MiB, like any other image, is shown through its stored preview', async () => {
  const { reads, source } = world({ 1: { sizeBytes: 5n * 1024n * 1024n } })
  const rendered = await renderPromptImages([toolTurn(1)], source, { supportsVision: true })
  assert.deepEqual(reads, [{ id: idOf(1), source: 'thumbnail' }])
  assert.equal(imagesOf(rendered[0])[0]?.mime, 'image/webp')
})

test('the six-image budget is shared with the messages’ own images, newest first', async () => {
  const { source } = world({ 1: {}, 2: {}, 3: {} })
  const transcript = [
    covered({ content: 'four photos', images: [photo(1), photo(2), photo(3), photo(4)], role: 'user' }),
    toolTurn(1, 2, 3),
  ]
  const rendered = await renderPromptImages(transcript, source, { supportsVision: true })
  assert.equal(imagesOf(rendered[1]).length, 3, 'the newest turn, the tool images, are all shown')
  assert.deepEqual(imagesOf(rendered[0]), [photo(1), photo(2), photo(3)], 'the older message keeps what is left')
  assert.equal(finalizeProvenancedProviderInput(rendered).kind, 'ready', 'a trimmed message keeps its coverage')
})

test('when the budget runs out inside a tool turn, the rest are named as not shown', async () => {
  const { reads, source } = world({ 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {}, 7: {}, 8: {} })
  const transcript = [toolTurn(1, 2, 3, 4), toolTurn(5, 6, 7, 8)]
  const rendered = await renderPromptImages(transcript, source, { supportsVision: true })
  assert.equal(imagesOf(rendered[1]).length, 4)
  assert.equal(imagesOf(rendered[0]).length, 2)
  const olderLines = (rendered[0] as { content: string }).content.split('\n')
  assert.equal(olderLines[3], '[image 3: screenshot, 13 KB] from executor_mcp_call (not shown: this prompt already carries 6 images)')
  assert.equal(reads.length, 6, 'nothing past the budget is read')
})

test('only the newest two tool turns carry pictures; an older one says so and is never read', async () => {
  const { lookups, reads, source } = world({ 1: {}, 2: {}, 3: {} })
  const rendered = await renderPromptImages([toolTurn(1), toolTurn(2), toolTurn(3)], source, { supportsVision: true })
  assert.deepEqual(rendered[0], { content: `${TOOL_IMAGES_INTRO}\n${EARLIER_TOOL_IMAGES_TEXT}`, role: 'user' })
  assert.equal(imagesOf(rendered[1]).length, 1)
  assert.equal(imagesOf(rendered[2]).length, 1)
  assert.deepEqual(reads.map((read) => read.id).sort(), [idOf(2), idOf(3)])
  assert.deepEqual(lookups.flat().sort(), [idOf(2), idOf(3)])
})

test('a model that cannot see images reads none, and each image line names the text alternative', async () => {
  const { lookups, reads, source } = world({ 1: {}, 2: {} })
  const transcript = [
    covered({ content: 'a photo', images: [photo(1)], role: 'user' }),
    toolTurn(1, 2),
  ]
  const rendered = await renderPromptImages(transcript, source, { supportsVision: false })
  assert.deepEqual(rendered[1], {
    content: [
      TOOL_IMAGES_INTRO,
      `[image 1: screenshot, 13 KB] from executor_mcp_call ${TOOL_IMAGES_NOT_SEEN_NOTE}`,
      `[image 2: screenshot, 13 KB] from executor_mcp_call ${TOOL_IMAGES_NOT_SEEN_NOTE}`,
    ].join('\n'),
    role: 'user',
  })
  assert.deepEqual(rendered[0], { content: 'a photo', role: 'user' }, 'a message’s own images are dropped too')
  assert.equal(reads.length + lookups.length, 0, 'nothing is read for a model that cannot look')
  assert.equal(finalizeProvenancedProviderInput(rendered).kind, 'ready')
})

test('an image of another run’s command, or one that has vanished, is not read', async () => {
  const { reads, source } = world({ 1: { command: OTHER_RUNS_COMMAND } })
  const rendered = await renderPromptImages([toolTurn(1, 2)], source, { supportsVision: true })
  assert.deepEqual(imagesOf(rendered[0]), [])
  assert.deepEqual((rendered[0] as { content: string }).content.split('\n').slice(1), [
    '[image 1: screenshot, 13 KB] from executor_mcp_call (could not be loaded)',
    '[image 2: screenshot, 13 KB] from executor_mcp_call (could not be loaded)',
  ])
  assert.deepEqual(reads, [], 'FileService is not even asked')
})

test('a failed lookup costs the call its pictures, never the call', async () => {
  const { source } = world({ 1: {} })
  const failing = {
    ...source,
    prisma: { attachment: { findMany: async () => { throw new Error('connection reset') } } } as unknown as PrismaClient,
  }
  const rendered = await renderPromptImages([toolTurn(1)], failing, { supportsVision: true })
  assert.match((rendered[0] as { content: string }).content, /\(could not be loaded\)$/)
})

test('the run keeps the pictures it is still showing, and lets go of the rest', async () => {
  const { reads, source } = world({ 1: {}, 2: {}, 3: {} })
  const cache: ToolImageCache = new Map()
  await renderPromptImages([toolTurn(1), toolTurn(2)], source, { cache, supportsVision: true })
  assert.equal(reads.length, 2)
  await renderPromptImages([toolTurn(1), toolTurn(2)], source, { cache, supportsVision: true })
  assert.equal(reads.length, 2, 'a second iteration reads nothing again')
  await renderPromptImages([toolTurn(1), toolTurn(2), toolTurn(3)], source, { cache, supportsVision: true })
  assert.deepEqual([...cache.keys()].sort(), [idOf(2), idOf(3)])
  assert.equal(reads.length, 3)
})
