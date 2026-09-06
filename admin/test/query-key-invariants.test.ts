import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The prefix rule, enforced instead of asserted.
 *
 * The key factories exist so "invalidating a family's root reaches the whole
 * family" is checkable in one place. A prose list of exceptions in a header is
 * the same thing that rotted everywhere else — it drifts the moment someone
 * adds a key and does not read it. So the rule is a test, and every deliberate
 * exception is data with a reason attached.
 *
 * Adding a key outside its family root fails this test. Removing the need for a
 * listed exception fails it too, so the list cannot outlive its reasons.
 *
 * The families live one per facade (`src/facades/<domain>/keys.ts`), plus the
 * cross-cutting handful in `src/lib/query-keys.ts`, so the check enumerates
 * them from the filesystem rather than from one module's exports: a domain that
 * moved its keys out of the central module must not thereby move them out of
 * the check, and a new facade is covered the moment its `keys.ts` exists.
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
  'taskKeys.presented':
    'One TaskRecord, not TaskRecord[]. A ticket card shown in a conversation reads its task '
    + "through the ordinary endpoint, and the board's optimistic sweep over [\"tasks\"] rewrites "
    + 'every match as an array — so nesting would hand it a single record to patch.',
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

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url))
const FACADES_ROOT = join(SOURCE_ROOT, 'facades')

/** Where the literals live; every other file must import from one of these. */
const CENTRAL_KEY_MODULE = 'lib/query-keys.ts'

/**
 * A filesystem walk, not `git ls-files`: a `keys.ts` that has just been written
 * is covered by this test before it is ever staged, which is the point at which
 * a root escape is cheapest to fix.
 */
const keyModules = (): string[] => {
  const found = [join(SOURCE_ROOT, CENTRAL_KEY_MODULE)]
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (entry.name === 'keys.ts') found.push(join(dir, entry.name))
    }
  }
  walk(FACADES_ROOT)
  return found
}

const KEY_MODULE_PATHS = keyModules()
const KEY_MODULE_FILES = new Set(KEY_MODULE_PATHS.map((path) => relative(SOURCE_ROOT, path)))

/** `[module, familyName, family]` for every `*Keys` object in every key module. */
const families: [string, string, Record<string, unknown>][] = (
  await Promise.all(
    KEY_MODULE_PATHS.map(async (path) => {
      const loaded = (await import(pathToFileURL(path).href)) as Record<string, unknown>
      return Object.entries(loaded)
        .filter(
          (entry): entry is [string, Record<string, unknown>] =>
            entry[0].endsWith('Keys') && typeof entry[1] === 'object' && entry[1] !== null,
        )
        .map(([name, family]): [string, string, Record<string, unknown>] => [
          relative(SOURCE_ROOT, path),
          name,
          family,
        ])
    }),
  )
).flat()

const familyNamed = (name: string): Record<string, unknown> | null =>
  families.find(([, familyName]) => familyName === name)?.[2] ?? null

test('the key modules are enumerated from the facades, not from one module', () => {
  assert.ok(
    KEY_MODULE_FILES.has(CENTRAL_KEY_MODULE),
    'expected the cross-cutting module in the enumeration',
  )
  assert.ok(
    KEY_MODULE_PATHS.length > 30,
    `expected a keys.ts per domain facade, found ${KEY_MODULE_PATHS.length}`,
  )
  const duplicated = families
    .map(([, name]) => name)
    .filter((name, index, all) => all.indexOf(name) !== index)
  assert.deepEqual(
    duplicated,
    [],
    'A family name is declared in two key modules; one of them is a second cache identity for the '
      + 'same records:\n' + duplicated.join('\n'),
  )
})

test('every key family is reachable from its own root', () => {
  assert.ok(families.length > 20, 'expected the walk to reach the admin key families')

  const escapes: string[] = []
  for (const [, familyName, family] of families) {
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
    const record = familyNamed(familyName ?? '')
    if (!record) {
      stale.push(`${qualified}: family no longer exists`)
      continue
    }
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
  // prefix, which is the drift the factories remove. Spot-check the families
  // whose roots exist only as a spread base.
  const appKeys = familyNamed('appKeys') as {
    all: readonly string[]
    detail: (slug: string) => readonly unknown[]
  }
  const dashboardKeys = familyNamed('dashboardKeys') as {
    widgetDataView: (widgetId: string, suffix: string) => readonly unknown[]
  }
  const workflowKeys = familyNamed('workflowKeys') as {
    run: (id: string) => readonly unknown[]
    runs: readonly string[]
  }

  assert.deepEqual(appKeys.detail('slug').slice(0, appKeys.all.length), [...appKeys.all])
  assert.deepEqual(
    dashboardKeys.widgetDataView('w-1', '').slice(0, 3),
    ['dashboards', 'widget-data', 'w-1'],
  )
  assert.deepEqual(workflowKeys.run('r-1').slice(0, workflowKeys.runs.length), [...workflowKeys.runs])
})

/**
 * One key, one owner — across facades.
 *
 * Now that the families live in forty-odd files, the cheapest mistake to make
 * is for a second facade to re-declare a key the owning one already builds:
 * two names for one cache entry, and the second is the one nobody remembers to
 * invalidate. Sharing the SAME array is the opposite and is how a sub-resource
 * stays reachable — `agentTodoKeys.all` IS `agentKeys.all`, imported across the
 * facade boundary — so identity, not equality, separates the two.
 *
 * Collisions inside one family are its own business: `knowledgeKeys.space` and
 * `knowledgeKeys.scopedSpaces` take disjoint id namespaces and only look equal
 * under this test's placeholder argument.
 */
test('no two facades claim the same key', () => {
  const claims = new Map<string, { qualified: string; family: string; value: readonly unknown[] }[]>()
  for (const [, familyName, family] of families) {
    for (const [memberName, member] of Object.entries(family)) {
      const key = emit(member)
      if (!key) continue
      const serialised = JSON.stringify(key)
      claims.set(serialised, [
        ...(claims.get(serialised) ?? []),
        { qualified: `${familyName}.${memberName}`, family: familyName, value: key },
      ])
    }
  }

  const collisions = [...claims.entries()]
    .filter(([, claimants]) => {
      if (new Set(claimants.map((claim) => claim.family)).size < 2) return false
      return new Set(claimants.map((claim) => claim.value)).size > 1
    })
    .map(([key, claimants]) => `${key} <- ${claimants.map((c) => c.qualified).join(', ')}`)

  assert.deepEqual(
    collisions,
    [],
    'These keys are declared by more than one facade. Import the owning facade\'s keys.ts instead '
      + 'of spelling a second one:\n' + collisions.join('\n'),
  )
})

/**
 * A `*Keys` object anywhere but a `keys.ts` is the F2 shape: a family invisible
 * to every check above, because the enumeration walks `keys.ts` files. Five of
 * them had accumulated in facade `hooks.ts` files before this gate existed.
 */
test('a facade declares its key family in keys.ts and nowhere else', () => {
  const strays: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (entry.name === 'keys.ts' || !isSourceFile(entry.name)) continue
      readFileSync(full, 'utf8').split('\n').forEach((line, index) => {
        if (/^export const [A-Za-z]*Keys\b/.test(line)) {
          strays.push(`${relative(SOURCE_ROOT, full)}:${index + 1}  ${line.trim()}`)
        }
      })
    }
  }
  walk(FACADES_ROOT)

  assert.deepEqual(
    strays,
    [],
    'A key family declared outside a facade\'s keys.ts is checked by nothing — move it to '
      + 'keys.ts beside its facade:\n' + strays.join('\n'),
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
 * than of the imported module. It reads every file under `admin/src` (the key
 * modules themselves excepted, since that is where the literals belong) and
 * refuses an array literal handed to `queryKey` or passed positionally to the
 * query filters. A key built by a factory — `secretKeys.all`,
 * `threadKeys.messages(id)` — is what passes.
 */

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

const isSourceFile = (name: string) => name.endsWith('.ts') || name.endsWith('.tsx')

const sourceFiles = (): string[] => {
  const found: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), relativePath)
      else if (entry.isFile() && isSourceFile(entry.name)) found.push(relativePath)
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

test('no raw query-key literal outside a key module', () => {
  const files = sourceFiles()
  assert.ok(files.length > 100, 'expected the scan to reach the admin source tree')
  assert.ok(
    files.includes(CENTRAL_KEY_MODULE),
    `expected ${CENTRAL_KEY_MODULE} in the scanned tree`,
  )

  const violations: string[] = []
  for (const file of files) {
    if (KEY_MODULE_FILES.has(file)) continue
    const contents = readFileSync(join(SOURCE_ROOT, file), 'utf8')
    contents.split('\n').forEach((line, index) => {
      if (isCommentLine(line)) return
      const hit = RAW_KEY_PATTERNS.find(({ pattern }) => pattern.test(line))
      if (!hit) return
      violations.push(`${file}:${index + 1}  ${hit.label}  ${line.trim()}`)
    })
  }

  assert.deepEqual(
    violations,
    [],
    'These call sites spell a cache key inline instead of calling a factory in the owning facade\'s '
      + 'keys.ts. '
      + 'A literal is a second definition of the same cache identity and stops matching the moment '
      + 'either side moves — add or reuse a factory:\n' + violations.join('\n'),
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
