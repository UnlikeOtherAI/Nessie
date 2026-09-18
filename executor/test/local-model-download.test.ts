import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'

import type { LocalModelFile } from '@nessie/schemas'

import {
  downloadModelFile,
  hasRoomFor,
  parseContentRangeTotal,
  stagedFilePath,
  verifiedFilePath,
  type WeightsFetch,
} from '../src/local-model-download.js'

const BYTES = Buffer.from('the weights, such as they are, in this test')
const DIGEST = createHash('sha256').update(BYTES).digest('hex')

const fileOf = (overrides: Partial<LocalModelFile> = {}): LocalModelFile => ({
  key: `gemma4/e2b/q4_0/${DIGEST}/model.gguf`,
  sha256: DIGEST,
  bytes: BYTES.byteLength,
  upstream: 'hf:example/test',
  ...overrides,
})

const withStateDir = async (run: (stateDir: string) => Promise<void>): Promise<void> => {
  const stateDir = await mkdtemp(resolve(tmpdir(), 'nessie-local-model-'))
  try {
    await run(stateDir)
  } finally {
    await rm(stateDir, { force: true, recursive: true })
  }
}

const respondWholeObject: WeightsFetch = (_url, _init) =>
  Promise.resolve(
    new Response(new Uint8Array(BYTES), {
      status: 200,
      headers: { 'content-length': String(BYTES.byteLength), etag: '"v1"' },
    }),
  )

const plentyOfRoom = () => Promise.resolve({ bavail: 1_000_000, bsize: 4_096 })

test('a whole object that hashes to its pin lands under its final name', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const seen: number[] = []
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      onProgress: (progress) => seen.push(progress.downloadedBytes),
      statfsImpl: plentyOfRoom,
    })

    assert.deepEqual(outcome, { ok: true, path: verifiedFilePath(stateDir, 'gemma4-e2b-q4', file) })
    assert.deepEqual(await readFile(outcome.ok ? outcome.path : ''), BYTES)
    assert.equal(seen.at(-1), BYTES.byteLength)
    await assert.rejects(stat(stagedFilePath(stateDir, 'gemma4-e2b-q4', file)))
  })
})

test('bytes that hash to anything else are refused, and the partial is destroyed', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf({ sha256: 'a'.repeat(64) })
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'digest_mismatch')
    assert.equal(outcome.ok === false && outcome.observedDigest, DIGEST)
    // Nothing is left that a resume could build on, and nothing is advertised.
    await assert.rejects(stat(stagedFilePath(stateDir, 'gemma4-e2b-q4', file)))
    await assert.rejects(stat(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)))
  })
})

test('a 206 whose total is not the pinned length is refused before a byte is written', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    await writeFile(partPath, BYTES.subarray(0, 10))

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: () =>
        Promise.resolve(
          new Response(new Uint8Array(BYTES.subarray(10)), {
            status: 206,
            // A different build sitting behind the same URL.
            headers: { 'content-range': `bytes 10-41/999999` },
          }),
        ),
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok === false && outcome.reason, 'size_mismatch')
  })
})

test('a resumed download continues one digest over the bytes already on disk', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    await writeFile(partPath, BYTES.subarray(0, 10))

    let requestedRange: string | undefined
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: (_url, init) => {
        requestedRange = init.headers.Range
        return Promise.resolve(
          new Response(new Uint8Array(BYTES.subarray(10)), {
            status: 206,
            headers: { 'content-range': `bytes 10-${BYTES.byteLength - 1}/${BYTES.byteLength}` },
          }),
        )
      },
      statfsImpl: plentyOfRoom,
    })

    assert.equal(requestedRange, 'bytes=10-')
    assert.equal(outcome.ok, true)
    assert.deepEqual(await readFile(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)), BYTES)
  })
})

test('a mirror that ignores the range and sends the whole object still ends at the right digest', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const partPath = stagedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(partPath, '..'), { recursive: true })
    await writeFile(partPath, Buffer.from('rubbish that is not our prefix'))

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok, true)
    assert.deepEqual(await readFile(verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)), BYTES)
  })
})

test('a live lock holder is respected rather than raced', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const directory = resolve(stagedFilePath(stateDir, 'gemma4-e2b-q4', file), '..')
    await mkdir(directory, { recursive: true })
    await writeFile(
      resolve(directory, '.downloading'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    )

    // A throw from inside fetchImpl would be caught and reported as
    // `mirror_unreachable`, so "did not dial" has to be observed, not asserted.
    let dialed = false
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: (url, init) => {
        dialed = true
        return respondWholeObject(url, init)
      },
      statfsImpl: plentyOfRoom,
    })

    assert.equal(dialed, false)
    assert.equal(outcome.ok === false && outcome.reason, 'download_in_progress')
  })
})

test('a lock left by a dead process is cleared', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const directory = resolve(stagedFilePath(stateDir, 'gemma4-e2b-q4', file), '..')
    await mkdir(directory, { recursive: true })
    await writeFile(
      resolve(directory, '.downloading'),
      JSON.stringify({ pid: 2_147_483_600, startedAt: new Date().toISOString() }),
    )

    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: respondWholeObject,
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok, true)
  })
})

test('a volume without room for the file and Ollama copy of it refuses the pull', async () => {
  await withStateDir(async (stateDir) => {
    let dialed = false
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file: fileOf(),
      stateDir,
      fetchImpl: (url, init) => {
        dialed = true
        return respondWholeObject(url, init)
      },
      // Less than the file itself, let alone the copy Ollama's import makes.
      statfsImpl: () => Promise.resolve({ bavail: 10, bsize: 1 }),
    })

    assert.equal(dialed, false)
    assert.equal(outcome.ok === false && outcome.reason, 'no_storage')
  })
})

test('an already-verified file is not fetched again', async () => {
  await withStateDir(async (stateDir) => {
    const file = fileOf()
    const finalPath = verifiedFilePath(stateDir, 'gemma4-e2b-q4', file)
    await mkdir(resolve(finalPath, '..'), { recursive: true })
    await writeFile(finalPath, BYTES)

    let dialed = false
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file,
      stateDir,
      fetchImpl: (url, init) => {
        dialed = true
        return respondWholeObject(url, init)
      },
      statfsImpl: plentyOfRoom,
    })

    assert.equal(dialed, false)
    assert.deepEqual(outcome, { ok: true, path: finalPath })
  })
})

test('an unreachable mirror is a reported reason, not a throw', async () => {
  await withStateDir(async (stateDir) => {
    const outcome = await downloadModelFile({
      baseUrl: 'https://mirror.example.com',
      entryId: 'gemma4-e2b-q4',
      file: fileOf(),
      stateDir,
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
      statfsImpl: plentyOfRoom,
    })

    assert.equal(outcome.ok === false && outcome.reason, 'mirror_unreachable')
  })
})

test('content-range totals are read strictly', () => {
  assert.equal(parseContentRangeTotal('bytes 0-9/100'), 100)
  assert.equal(parseContentRangeTotal('bytes 0-9/*'), undefined)
  assert.equal(parseContentRangeTotal('items 0-9/100'), undefined)
  assert.equal(parseContentRangeTotal(null), undefined)
})

test('an unreadable volume does not block a download', async () => {
  const room = await hasRoomFor('/nowhere', 10, () => Promise.reject(new Error('ENOENT')))
  assert.equal(room.ok, true)
})
