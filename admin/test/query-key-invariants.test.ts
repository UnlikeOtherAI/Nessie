import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as queryKeys from '../src/lib/query-keys.js'

/**
 * The prefix rule, enforced instead of asserted.
 *
 * query-keys.ts exists so "invalidating a family's root reaches the whole
 * family" is checkable in one place. A prose list of exceptions in its header
 * is the same thing that rotted everywhere else — it drifts the moment someone
 * adds a key and does not read it. So the rule is a test, and every deliberate
 * exception is data with a reason attached.
 *
 * Adding a key outside its family root fails this test. Removing the need for a
 * listed exception fails it too, so the list cannot outlive its reasons.
 */

// key = `${family}.${member}`. The reason is why nesting would cost more than
// the staleness it fixes — expense, or a shape the parent's consumers misread.
const ROOT_EXCEPTIONS: Record<string, string> = {
  'projectKeys.insights':
    'A velocity/burndown report — one query per completed iteration plus a task-event scan. '
    + 'Nothing that invalidates ["projects"] (rename, delete, membership, board style) can change it.',
  'taskKeys.assignees':
    'AssignableUser[], not TaskRecord[]. The board\'s optimistic sweep over ["tasks"] rewrites every '
    + 'match as TaskRecord[], so nesting would hand it a foreign shape.',
  'taskKeys.documents':
    'Task documents are invalidated by their own mutations (facades/knowledge/task-docs-hooks.ts); '
    + 'no task mutation changes them, and the board sweep over ["tasks"] would misread the shape.',
  'dashboardKeys.embed':
    'An embed is addressed by its own public token, not by the dashboard id, so a dashboard '
    + 'invalidation has no id to reach it with.',
  'dashboardKeys.sources':
    'The org-wide widget source catalogue, not a projection of any one dashboard.',
  'knowledgeKeys.versions':
    'Immutable history. A page edit appends, so the list is refetched by its own mutation rather '
    + 'than by every page invalidation.',
  'knowledgeKeys.attachments':
    'Attachment bytes are immutable and their list changes only through upload/delete, which '
    + 'invalidate it directly.',
}

const isKeyArray = (value: unknown): value is readonly unknown[] => Array.isArray(value)

/** Call a factory with placeholder arguments; optional params default themselves. */
const emit = (member: unknown): readonly unknown[] | null => {
  if (isKeyArray(member)) return member
  if (typeof member !== 'function') return null
  const args = Array.from({ length: member.length }, () => 'x')
  const produced = (member as (...rest: unknown[]) => unknown)(...args)
  return isKeyArray(produced) ? produced : null
}

const families = Object.entries(queryKeys).filter(
  (entry): entry is [string, Record<string, unknown>] =>
    entry[0].endsWith('Keys') && typeof entry[1] === 'object' && entry[1] !== null,
)

test('every key family is reachable from its own root', () => {
  assert.ok(families.length > 20, 'expected the module to export the admin key families')

  const escapes: string[] = []
  for (const [familyName, family] of families) {
    const root = family.all
    if (!isKeyArray(root)) continue

    for (const [memberName, member] of Object.entries(family)) {
      if (memberName === 'all') continue
      const key = emit(member)
      if (!key) continue

      const qualified = `${familyName}.${memberName}`
      const nested = root.every((segment, index) => key[index] === segment)
      if (!nested && !(qualified in ROOT_EXCEPTIONS)) {
        escapes.push(`${qualified} -> ${JSON.stringify(key)} is not under ${JSON.stringify(root)}`)
      }
    }
  }

  assert.deepEqual(
    escapes,
    [],
    'These keys escape their family root. Nest them, or add them to ROOT_EXCEPTIONS with the reason '
      + 'nesting costs more than the staleness it fixes:\n' + escapes.join('\n'),
  )
})

test('no exception outlives its reason', () => {
  const stale: string[] = []
  for (const qualified of Object.keys(ROOT_EXCEPTIONS)) {
    const [familyName, memberName] = qualified.split('.')
    const family = (queryKeys as Record<string, unknown>)[familyName ?? '']
    if (typeof family !== 'object' || family === null) {
      stale.push(`${qualified}: family no longer exists`)
      continue
    }
    const record = family as Record<string, unknown>
    const root = record.all
    const key = emit(record[memberName ?? ''])
    if (!key) {
      stale.push(`${qualified}: member no longer exists`)
      continue
    }
    if (isKeyArray(root) && root.every((segment, index) => key[index] === segment)) {
      stale.push(`${qualified}: now nested under its root — delete the exception`)
    }
  }

  assert.deepEqual(stale, [], stale.join('\n'))
})

test('every family root is the exact prefix its own children are built from', () => {
  // A child that re-spells its root's string is a second definition of the
  // prefix, which is the drift this module removes. Spot-check the families
  // whose roots exist only as a spread base.
  assert.deepEqual(
    queryKeys.appKeys.detail('slug').slice(0, queryKeys.appKeys.all.length),
    [...queryKeys.appKeys.all],
  )
  assert.deepEqual(
    queryKeys.dashboardKeys.widgetDataView('w-1', '').slice(0, 3),
    ['dashboards', 'widget-data', 'w-1'],
  )
  assert.deepEqual(
    queryKeys.workflowKeys.run('r-1').slice(0, queryKeys.workflowKeys.runs.length),
    [...queryKeys.workflowKeys.runs],
  )
})

/**
 * The factory rule, enforced instead of documented.
 *
 * The prefix rule above only sees keys that reached the module. A key spelled
 * inline at a call site never does: it is a second definition of the same cache
 * identity, invisible to every check here, and it stops matching the moment
 * either side moves. Seven of them reappeared within weeks of the module
 * landing — `['secrets']`, `['threads', 'activity']`, `['triggers']` and the
 * rest — which is the answer to whether a header comment is enough.
 *
 * The violation is textual, so the check is a scan of the source on disk rather
 * than of the imported module. It reads every file under `admin/src` (the
 * module itself excepted, since that is where the literals belong) and refuses
 * an array literal handed to `queryKey` or passed positionally to the query
 * filters. A key built by a factory — `secretKeys.all`,
 * `threadKeys.messages(id)` — is what passes.
 */

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url))

/** Where the literals live; every other file must import from it. */
const KEY_MODULE = 'lib/query-keys.ts'

/**
 * `queryKey: [...]`, `queryKey = [...]`, and `invalidateQueries([...])`.
 *
 * The positional list covers every `QueryFilters` taker that accepts a bare key
 * — the object form of each is already caught by the `queryKey:` pattern. Note
 * what is deliberately absent: `for (const queryKey of [a, b])` in
 * `TokenUsagePage` collects keys the billing facade built, so an array whose
 * ELEMENTS are factory calls is not a raw key and must keep passing.
 */
const RAW_KEY_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  // `queryKey: [` in a TYPE position — `{ queryKey: [string] }` — describes a
  // key's shape rather than building one, so the value form is required to
  // contain a quote, a spread, or a template literal. A key with no literal
  // segment at all cannot be a cache key worth guarding.
  { label: 'queryKey: [ … ]', pattern: /queryKey\s*:\s*\[\s*(?:['"`]|\.\.\.)/ },
  { label: 'queryKey = [ … ]', pattern: /\bqueryKey\s*=\s*\[/ },
  {
    label: 'someQueries([ … ])',
    pattern: /\b(?:invalidate|reset|cancel|refetch|remove)Queries\s*(?:<[^>]*>)?\(\s*\[/,
  },
  {
    // The write side takes the same key and was the one hole a verifier walked
    // through: `setQueryData([...APPS_QUERY_KEY, 'detail', slug], …)` was a
    // second spelling that diverged from the factory whenever slug was absent.
    label: 'someQueryData([ … ])',
    pattern: /\b(?:set|get)Quer(?:yData|iesData)\s*(?:<[^>]*>)?\(\s*\[/,
  },
]

/**
 * Call sites that genuinely cannot use a factory, as data with a reason — the
 * shape `ROOT_EXCEPTIONS` uses, for the same purpose: an exception that stops
 * being needed fails the test rather than lingering. `line` is the offending
 * source line, trimmed, so an exception cannot silently widen to cover a
 * different literal that drifts onto the same line number.
 */
const RAW_KEY_EXCEPTIONS: readonly { file: string; line: string; reason: string }[] = []

const isSourceFile = (name: string) => name.endsWith('.ts') || name.endsWith('.tsx')

const sourceFiles = (): string[] => {
  const found: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), relative)
      else if (entry.isFile() && isSourceFile(entry.name)) found.push(relative)
    }
  }
  walk(SOURCE_ROOT, '')
  return found
}

/**
 * Comment lines are prose about keys, not keys. A whole-line `//` or a
 * doc-comment `*` continuation is dropped; a trailing comment is not, because
 * cutting at the first `//` would also cut a `https://` inside a string and
 * hide a literal after it. False positives there are cheap and visible; a false
 * negative is a hole in the guard.
 */
const isCommentLine = (line: string) => {
  const trimmed = line.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

test('no raw query-key literal outside query-keys.ts', () => {
  const files = sourceFiles()
  assert.ok(files.length > 100, 'expected the scan to reach the admin source tree')
  assert.ok(files.includes(KEY_MODULE), `expected ${KEY_MODULE} in the scanned tree`)

  const violations: string[] = []
  const usedExceptions = new Set<string>()

  for (const file of files) {
    if (file === KEY_MODULE) continue
    const contents = readFileSync(join(SOURCE_ROOT, file), 'utf8')
    contents.split('\n').forEach((line, index) => {
      if (isCommentLine(line)) return
      const hit = RAW_KEY_PATTERNS.find(({ pattern }) => pattern.test(line))
      if (!hit) return
      const excepted = RAW_KEY_EXCEPTIONS.find(
        (entry) => entry.file === file && entry.line === line.trim(),
      )
      if (excepted) {
        usedExceptions.add(`${excepted.file} :: ${excepted.line}`)
        return
      }
      violations.push(`${file}:${index + 1}  ${hit.label}  ${line.trim()}`)
    })
  }

  assert.deepEqual(
    violations,
    [],
    'These call sites spell a cache key inline instead of calling a factory in lib/query-keys.ts. '
      + 'A literal is a second definition of the same cache identity and stops matching the moment '
      + 'either side moves — add or reuse a factory, or, if the site genuinely cannot, add it to '
      + 'RAW_KEY_EXCEPTIONS with the reason:\n' + violations.join('\n'),
  )

  const stale = RAW_KEY_EXCEPTIONS.filter(
    (entry) => !usedExceptions.has(`${entry.file} :: ${entry.line}`),
  ).map((entry) => `${entry.file} :: ${entry.line} (${entry.reason})`)

  assert.deepEqual(
    stale,
    [],
    'These RAW_KEY_EXCEPTIONS no longer match a call site — delete them:\n' + stale.join('\n'),
  )
})

test('the raw-key scan detects a literal when one is present', () => {
  // The guard above passes on a clean tree, which on its own is also what a
  // broken scanner does. This states what it is measuring: the same patterns,
  // run over the shapes they exist to catch and the shapes they must not.
  const caught = (line: string) => RAW_KEY_PATTERNS.some(({ pattern }) => pattern.test(line))

  for (const offender of [
    "    queryKey: ['secrets'],",
    "  const queryKey = ['threads', 'activity']",
    "void queryClient.invalidateQueries({ queryKey: ['triggers'] })",
    "void queryClient.invalidateQueries(['triggers'])",
    "queryClient.resetQueries([...threadKeys.activity])",
    "queryClient.cancelQueries(['tasks', projectId])",
  ]) {
    assert.ok(caught(offender), `scan missed a raw key: ${offender}`)
  }

  for (const allowed of [
    '    queryKey: secretKeys.all,',
    '    queryKey: threadKeys.messages(threadId),',
    'void queryClient.invalidateQueries({ queryKey: triggerKeys.all })',
    'void queryClient.resetQueries({ queryKey: threadKeys.activity })',
    '    for (const queryKey of [',
  ]) {
    assert.ok(!caught(allowed), `scan flagged a factory-built key: ${allowed}`)
  }
})
