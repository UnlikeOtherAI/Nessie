import assert from 'node:assert/strict'
import test from 'node:test'

import {
  McpLibraryError,
  REGISTRY_MAX_PAGE_BYTES,
  iterateRegistryPages,
} from '../src/index.js'

/**
 * The paged read. The registry is a third party, so every way it could fail to
 * terminate has to cost a finite number of requests and a finite number of
 * bytes.
 */

type PageSpec = { servers: unknown[]; nextCursor?: string }

const pager = (
  pages: PageSpec[],
): { fetchImpl: typeof fetch; urls: string[] } => {
  const urls: string[] = []
  let index = 0
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const page = pages[Math.min(index, pages.length - 1)]!
    index += 1
    return new Response(
      JSON.stringify({
        servers: page.servers,
        metadata: page.nextCursor ? { nextCursor: page.nextCursor } : {},
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return { fetchImpl, urls }
}

const drain = async (options: Parameters<typeof iterateRegistryPages>[0]) => {
  const collected: unknown[] = []
  for await (const { records } of iterateRegistryPages(options)) collected.push(...records)
  return collected
}

const pageNumbers = async (options: Parameters<typeof iterateRegistryPages>[0]) => {
  const pages: number[] = []
  for await (const { page } of iterateRegistryPages(options)) pages.push(page)
  return pages
}

test('follows the cursor until the registry stops offering one', async () => {
  const { fetchImpl, urls } = pager([
    { servers: ['a', 'b'], nextCursor: 'p2' },
    { servers: ['c'], nextCursor: 'p3' },
    { servers: ['d'] },
  ])

  assert.deepEqual(await drain({ fetchImpl }), ['a', 'b', 'c', 'd'])
  assert.equal(urls.length, 3)
  assert.ok(!urls[0]!.includes('cursor='), 'the first page carries no cursor')
  assert.ok(urls[1]!.includes('cursor=p2'))
  assert.ok(urls[2]!.includes('cursor=p3'))
})

test('a cursor that repeats itself ends the run instead of looping', async () => {
  const { fetchImpl, urls } = pager([{ servers: ['a'], nextCursor: 'same' }])

  assert.deepEqual(await drain({ fetchImpl }), ['a', 'a'])
  assert.equal(urls.length, 2, 'stopped the moment the cursor came back')
})

test('the record and page bounds are hard stops, not suggestions', async () => {
  const many = { servers: ['a', 'b', 'c'], nextCursor: 'next' }

  const byRecords = pager([many])
  assert.equal((await drain({ fetchImpl: byRecords.fetchImpl, maxRecords: 4 })).length, 4)

  // Each page hands back a fresh cursor, so only maxPages ends this.
  let cursor = 0
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ servers: ['x'], metadata: { nextCursor: `c${(cursor += 1)}` } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
  assert.equal((await drain({ fetchImpl, maxPages: 5 })).length, 5)
})

test('an unreadable page is an error about the registry, not a silent empty import', async () => {
  const badStatus = (async () => new Response('nope', { status: 500 })) as typeof fetch
  await assert.rejects(() => drain({ fetchImpl: badStatus }), McpLibraryError)

  const badShape = (async () =>
    new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  await assert.rejects(() => drain({ fetchImpl: badShape }), McpLibraryError)
})

test('a record the schema cannot read still reaches the caller to be counted', async () => {
  // The page parses as an array of unknown on purpose: one poison record must
  // cost one app, not the ninety-nine beside it.
  const { fetchImpl } = pager([{ servers: [{ nonsense: true }, 'a string', null] }])
  assert.deepEqual(await drain({ fetchImpl }), [{ nonsense: true }, 'a string', null])
})

test('pages arrive numbered from one, empty ones included', async () => {
  const { fetchImpl } = pager([
    { servers: ['a'], nextCursor: 'p2' },
    { servers: [], nextCursor: 'p3' },
    { servers: ['b'] },
  ])
  assert.deepEqual(await pageNumbers({ fetchImpl }), [1, 2, 3])
})

test('a page larger than the byte cap is refused, streamed or declared', async () => {
  // Counted as it arrives: nothing here declares a length, and the body is one
  // valid JSON document, so only the running total can stop it.
  const huge = 'x'.repeat(REGISTRY_MAX_PAGE_BYTES + 1)
  const streamed = (async () =>
    new Response(JSON.stringify({ servers: [{ pad: huge }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  await assert.rejects(() => drain({ fetchImpl: streamed }), McpLibraryError)

  // A declared length over the cap costs nothing to catch, so it is caught
  // before a single byte of body is read.
  const declared = (async () =>
    new Response(JSON.stringify({ servers: [] }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(REGISTRY_MAX_PAGE_BYTES + 1),
      },
    })) as typeof fetch
  await assert.rejects(() => drain({ fetchImpl: declared }), McpLibraryError)
})

test('a body that is not JSON is an error about the registry, not a raw SyntaxError', async () => {
  const notJson = (async () =>
    new Response('<html>maintenance</html>', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  await assert.rejects(() => drain({ fetchImpl: notJson }), McpLibraryError)
})
