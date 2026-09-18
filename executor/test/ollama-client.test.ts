import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_OLLAMA_ORIGIN,
  blobExists,
  detectOllama,
  importVerifiedModel,
  meetsVersionFloor,
  pushBlob,
  showModelDigests,
  type OllamaFetch,
} from '../src/ollama-client.js'

const DIGEST = 'a'.repeat(64)

const withFile = async (run: (path: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(resolve(tmpdir(), 'nessie-ollama-'))
  try {
    const path = resolve(directory, 'model.gguf')
    await writeFile(path, 'weights')
    await run(path)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('the version floor is compared per segment, not as a string', () => {
  assert.equal(meetsVersionFloor('0.34.0', '0.34.0'), true)
  assert.equal(meetsVersionFloor('0.34.1', '0.34.0'), true)
  assert.equal(meetsVersionFloor('0.9.0', '0.34.0'), false)
  // The string comparison this replaces would call '0.100.0' older than '0.34.0'.
  assert.equal(meetsVersionFloor('0.100.0', '0.34.0'), true)
  assert.equal(meetsVersionFloor('v0.35.2', '0.34.0'), true)
  assert.equal(meetsVersionFloor('not-a-version', '0.34.0'), false)
  assert.equal(meetsVersionFloor('', '0.34.0'), false)
})

test('a reachable Ollama above the floor is available', async () => {
  const presence = await detectOllama(DEFAULT_OLLAMA_ORIGIN, () =>
    Promise.resolve(json({ version: '0.34.1' })),
  )
  assert.deepEqual(presence, { available: true, version: '0.34.1' })
})

test('an Ollama below the floor says so rather than failing later', async () => {
  const presence = await detectOllama(DEFAULT_OLLAMA_ORIGIN, () =>
    Promise.resolve(json({ version: '0.20.0' })),
  )
  assert.deepEqual(presence, { available: false, reason: 'too_old', version: '0.20.0' })
})

test('no Ollama at all is a reported absence, not a throw', async () => {
  const presence = await detectOllama(DEFAULT_OLLAMA_ORIGIN, () =>
    Promise.reject(new Error('ECONNREFUSED')),
  )
  assert.deepEqual(presence, { available: false, reason: 'unreachable' })
})

test('a version response that is not a version is not trusted', async () => {
  const presence = await detectOllama(DEFAULT_OLLAMA_ORIGIN, () =>
    Promise.resolve(json({ version: 42 })),
  )
  assert.deepEqual(presence, { available: false, reason: 'unreachable' })
})

test('a blob Ollama does not hold reads as absent', async () => {
  const absent = await blobExists(DEFAULT_OLLAMA_ORIGIN, DIGEST, () =>
    Promise.resolve(new Response(null, { status: 404 })),
  )
  const present = await blobExists(DEFAULT_OLLAMA_ORIGIN, DIGEST, () =>
    Promise.resolve(new Response(null, { status: 200 })),
  )
  assert.equal(absent, false)
  assert.equal(present, true)
})

test('Ollama disagreeing with our hash is a terminal digest rejection', async () => {
  await withFile(async (path) => {
    const outcome = await pushBlob(DEFAULT_OLLAMA_ORIGIN, DIGEST, path, () =>
      Promise.resolve(new Response('digest mismatch', { status: 400 })),
    )
    assert.deepEqual(outcome, { ok: false, reason: 'digest_rejected' })
  })
})

test('the digest travels in the URL, where Ollama can check it against the body', async () => {
  await withFile(async (path) => {
    let seenUrl = ''
    let seenMethod = ''
    await pushBlob(DEFAULT_OLLAMA_ORIGIN, DIGEST, path, (url, init) => {
      seenUrl = url
      seenMethod = init.method ?? 'GET'
      return Promise.resolve(new Response(null, { status: 201 }))
    })
    assert.equal(seenUrl, `${DEFAULT_OLLAMA_ORIGIN}/api/blobs/sha256:${DIGEST}`)
    assert.equal(seenMethod, 'POST')
  })
})

test('show digests are read out of whatever shape the response happens to be', async () => {
  const digests = await showModelDigests(DEFAULT_OLLAMA_ORIGIN, 'nessie/gemma4-e2b-q4', () =>
    Promise.resolve(
      json({
        details: { families: ['gemma4'] },
        layers: [{ digest: `sha256:${DIGEST}`, mediaType: 'application/vnd.ollama.image.model' }],
      }),
    ),
  )
  assert.deepEqual(digests, [DIGEST])
})

test('an unreadable show response proves nothing', async () => {
  const digests = await showModelDigests(DEFAULT_OLLAMA_ORIGIN, 'nessie/gemma4-e2b-q4', () =>
    Promise.resolve(new Response('not json', { status: 200 })),
  )
  assert.equal(digests, undefined)
})

test('an import is only believed once Ollama reports holding the pinned blob', async () => {
  await withFile(async (path) => {
    const calls: string[] = []
    const fetchImpl: OllamaFetch = (url, init) => {
      calls.push(url)
      if (url.endsWith('/api/show')) return Promise.resolve(json({ layers: [{ digest: `sha256:${DIGEST}` }] }))
      if (url.includes('/api/blobs/')) {
        // HEAD says Ollama does not hold it; the POST that follows accepts it.
        return Promise.resolve(new Response(null, { status: init.method === 'POST' ? 201 : 404 }))
      }
      return Promise.resolve(json({ status: 'success' }))
    }

    const outcome = await importVerifiedModel({
      digest: DIGEST,
      fileName: 'model.gguf',
      modelName: 'nessie/gemma4-e2b-q4',
      origin: DEFAULT_OLLAMA_ORIGIN,
      path,
      fetchImpl,
    })

    assert.deepEqual(outcome, { ok: true })
    assert.ok(calls.some((url) => url.endsWith('/api/create')))
    assert.ok(calls.some((url) => url.endsWith('/api/show')))
  })
})

test('a model that does not report our pin is refused, however it is named', async () => {
  await withFile(async (path) => {
    const fetchImpl: OllamaFetch = (url) => {
      if (url.endsWith('/api/show')) {
        // Some other model's blob, under the name we asked for.
        return Promise.resolve(json({ layers: [{ digest: `sha256:${'b'.repeat(64)}` }] }))
      }
      if (url.includes('/api/blobs/')) return Promise.resolve(new Response(null, { status: 200 }))
      return Promise.resolve(json({ status: 'success' }))
    }

    const outcome = await importVerifiedModel({
      digest: DIGEST,
      fileName: 'model.gguf',
      modelName: 'nessie/gemma4-e2b-q4',
      origin: DEFAULT_OLLAMA_ORIGIN,
      path,
      fetchImpl,
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, 'digest_unconfirmed')
  })
})

test('a blob Ollama already holds is not uploaded twice', async () => {
  await withFile(async (path) => {
    let uploads = 0
    const fetchImpl: OllamaFetch = (url, init) => {
      if (url.includes('/api/blobs/')) {
        if (init.method === 'POST') uploads += 1
        return Promise.resolve(new Response(null, { status: 200 }))
      }
      if (url.endsWith('/api/show')) return Promise.resolve(json({ layers: [{ digest: `sha256:${DIGEST}` }] }))
      return Promise.resolve(json({ status: 'success' }))
    }

    const outcome = await importVerifiedModel({
      digest: DIGEST,
      fileName: 'model.gguf',
      modelName: 'nessie/gemma4-e2b-q4',
      origin: DEFAULT_OLLAMA_ORIGIN,
      path,
      fetchImpl,
    })

    assert.equal(outcome.ok, true)
    assert.equal(uploads, 0)
  })
})
