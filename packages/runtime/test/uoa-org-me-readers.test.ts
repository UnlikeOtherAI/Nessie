import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Every per-request UOA `GET /org/me` goes through `readUoaOrgMe`, so a burst
// of concurrent callers — a page load, an event replay — costs UOA one read,
// not one per caller (UOA incident 2026-09-26: ~100 `/org/me` reads per token
// renewal). This guard walks the server-side source trees and fails on any
// reader that is not on the allow-list below.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

const sourceRoots = (): string[] => {
  const roots = [join(ROOT, 'api/src'), join(ROOT, 'worker/src')]
  for (const entry of readdirSync(join(ROOT, 'packages'))) {
    const src = join(ROOT, 'packages', entry, 'src')
    if (statSync(join(ROOT, 'packages', entry)).isDirectory() && existsSync(src)) {
      roots.push(src)
    }
  }
  return roots
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'test') return []
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

// A file sends `/org/me` when it passes the path to the two UOA request
// helpers or builds it into a fetch URL template. A comment that merely
// mentions `/org/me` matches none of these shapes.
const sendsOrgMeRead = (source: string): boolean =>
  /requestUoaOrganization\([\s\S]{0,200}?\/org\/me/.test(source)
  || /rosterRequest\([\s\S]{0,200}?\/org\/me/.test(source)
  || /`\$\{[^`]*\/org\/me/.test(source)

const ALLOWED_READERS: Record<string, string> = {
  'api/src/services/executor-pairing-identity.ts':
    'one read per machine pairing claim, not a per-request path',
  'api/src/services/uoa-directory-refresh.ts':
    'has its own per-user in-flight join plus attempt cooldown',
  'api/src/services/uoa-team-directory.ts':
    'the login-time directory read, made once with the freshly issued token',
  'packages/runtime/src/uoa-org-me.ts':
    'the coalesced reader itself',
}

test('every /org/me reader is readUoaOrgMe or a justified exception', () => {
  const readers = sourceRoots()
    .flatMap((root) => walk(root))
    .filter((file) => (file.endsWith('.ts') || file.endsWith('.tsx')) && !file.endsWith('.test.ts'))
    .filter((file) => sendsOrgMeRead(readFileSync(file, 'utf8')))
    .map((file) => relative(ROOT, file).replaceAll('\\', '/'))
    .sort()

  assert.deepEqual(
    readers,
    Object.keys(ALLOWED_READERS).sort(),
    'a new `/org/me` caller must go through `readUoaOrgMe` so concurrent '
    + 'requests share one UOA read (UOA incident 2026-09-26)',
  )
})
