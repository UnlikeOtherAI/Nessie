import assert from 'node:assert/strict'
import test from 'node:test'

import { extractPngFromIco } from '../src/registry/icon-store.js'
import {
  conventionalCandidates,
  githubAvatarCandidate,
  parseDeclaredIconHrefs,
} from '../src/registry/icon-sources.js'

/**
 * Guessing four conventional paths resolved about a third of the catalogue.
 * Measured against fourteen rows that failed, eleven declared `<link rel=icon>`
 * at a path nobody could guess, three served a real ICO, and one answered
 * `/favicon.ico` with an HTML page. These pin each source added for that.
 */

// ─── What a page declares ───────────────────────────────────────────────────

test('declared icons are ranked, absolutised, and de-duplicated', () => {
  const html = `
    <link rel="mask-icon" href="/safari.svg" color="#000">
    <link rel="shortcut icon" href="favicon-32.png">
    <link rel="apple-touch-icon" sizes="180x180" href="https://cdn.example.net/touch.png">
    <link rel="icon" href="favicon-32.png">
    <link rel="stylesheet" href="/app.css">
  `
  assert.deepEqual(parseDeclaredIconHrefs(html, 'https://example.com'), [
    // apple-touch-icon first: specified to be a real raster of usable size.
    'https://cdn.example.net/touch.png',
    // Relative hrefs resolve against the page, and the duplicate collapses.
    'https://example.com/favicon-32.png',
    // A mask-icon is a monochrome silhouette, so it is the last resort.
    'https://example.com/safari.svg',
  ])
})

test('a declared href that is not fetchable is dropped, not passed along', () => {
  // `data:` and `javascript:` are not fetches, and a stylesheet is not an icon.
  const html = `
    <link rel="icon" href="data:image/png;base64,AAAA">
    <link rel="icon" href="javascript:alert(1)">
    <link rel="preload" href="https://example.com/not-an-icon.png">
    <link rel="icon">
  `
  assert.deepEqual(parseDeclaredIconHrefs(html, 'https://example.com'), [])
})

test('single quotes and unquoted attributes still parse', () => {
  // Real pages are not tidy; a miss here costs an icon, so be forgiving.
  assert.deepEqual(
    parseDeclaredIconHrefs("<link rel='icon' href='/a.png'><link rel=icon href=/b.png>", 'https://x.test'),
    ['https://x.test/a.png', 'https://x.test/b.png'],
  )
})

// ─── The publisher's avatar ─────────────────────────────────────────────────

test('a GitHub repository yields its owner avatar, and nothing else does', () => {
  assert.equal(
    githubAvatarCandidate('https://github.com/upstash/context7'),
    'https://github.com/upstash.png?size=128',
  )
  // Not GitHub, so there is no such convention to rely on.
  assert.equal(githubAvatarCandidate('https://gitlab.com/owner/repo'), null)
  // A lookalike host must not be mistaken for the real one.
  assert.equal(githubAvatarCandidate('https://github.com.evil.test/owner'), null)
  assert.equal(githubAvatarCandidate('https://raw.githubusercontent.com/o/r'), null)
  assert.equal(githubAvatarCandidate('not a url'), null)
})

test('an owner name outside GitHub’s own alphabet is refused', () => {
  // The owner is interpolated into a URL, so it is whitelisted rather than
  // escaped: a crafted path must not become a different GitHub URL.
  assert.equal(githubAvatarCandidate('https://github.com/..%2Fsomeone/repo'), null)
  assert.equal(githubAvatarCandidate('https://github.com/-leading/repo'), null)
  assert.equal(githubAvatarCandidate('https://github.com/ok-name/repo'), 'https://github.com/ok-name.png?size=128')
})

// ─── Conventional paths ─────────────────────────────────────────────────────

test('conventional candidates are origin-only and http(s)-only', () => {
  const candidates = conventionalCandidates('https://example.com/deep/page?q=1')
  assert.equal(candidates[0], 'https://example.com/apple-touch-icon.png')
  assert.equal(candidates.length, 4)
  assert.deepEqual(conventionalCandidates('file:///etc/passwd'), [])
})

// ─── ICO unwrapping ─────────────────────────────────────────────────────────

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452deadbeef', 'hex')

const icoContaining = (payloads: Buffer[]): Buffer => {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(payloads.length, 4)
  const directory = Buffer.alloc(16 * payloads.length)
  let offset = header.length + directory.length
  payloads.forEach((payload, index) => {
    directory.writeUInt32LE(payload.length, index * 16 + 8)
    directory.writeUInt32LE(offset, index * 16 + 12)
    offset += payload.length
  })
  return Buffer.concat([header, directory, ...payloads])
}

test('a PNG embedded in an ICO is lifted out, largest first', () => {
  // Several sites serve only `/favicon.ico`, and a modern one wraps a PNG.
  const small = Buffer.concat([PNG, Buffer.alloc(4)])
  const large = Buffer.concat([PNG, Buffer.alloc(64)])
  assert.deepEqual(extractPngFromIco(icoContaining([small, large])), large)
})

test('an ICO holding no PNG, and a non-ICO, both yield nothing', () => {
  // A legacy BMP-only ICO would need a decoder; refusing is the honest answer.
  assert.equal(extractPngFromIco(icoContaining([Buffer.alloc(32, 7)])), null)
  assert.equal(extractPngFromIco(PNG), null)
  assert.equal(extractPngFromIco(Buffer.alloc(2)), null)
})

test('a directory entry pointing outside the file is refused, not clamped', () => {
  // Every offset and length comes out of somebody else's file.
  const ico = icoContaining([PNG])
  ico.writeUInt32LE(0xffff_0000, 6 + 12)
  assert.equal(extractPngFromIco(ico), null)
})
