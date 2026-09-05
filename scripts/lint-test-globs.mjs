#!/usr/bin/env node

// Every test file a package holds is a test file that package's `test` script
// actually runs.
//
// `node --test` is handed explicit globs, so a `*.test.ts` outside them is not
// skipped loudly — it is never discovered at all. It passes review, it sits in
// the tree looking like coverage, and it runs neither locally nor in CI.
// `admin/src/lib/popover-placement.test.ts` lived that way from the commit that
// introduced it: ten cases, two of which had never been true, and nothing said
// so for as long as the file was next to its module instead of under `test/`.
//
// Colocating tests with source is fine — `worker`, `mobile` and
// `packages/mock-llm` all glob `src/**` on purpose. What is not fine is a
// package doing one thing in its script and another on disk. This gate compares
// the two.
//
// A package whose runner does its own discovery (vitest, jest) is reported as
// unchecked rather than failed: the check is "the declared globs cover the
// files", and a runner that declares none cannot be checked this way.

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Runners that find their own test files, so there are no globs to compare. */
const SELF_DISCOVERING = ['vitest', 'jest']

function fail(message) {
  console.error(message)
  process.exit(1)
}

function packageDirectories() {
  const output = execSync("git ls-files '*/package.json' 'package.json'", { encoding: 'utf8' })
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.includes('node_modules/'))
    .map((file) => path.dirname(file))
    .filter((directory) => directory !== '.')
    .sort()
}

function testFiles() {
  const output = execSync("git ls-files '*.test.ts' '*.test.tsx'", { encoding: 'utf8' })
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // Uncommitted deletions stay in the index until staged.
    .filter((file) => fs.existsSync(file))
}

/**
 * The `test` script with its intra-package `pnpm run <name>` hops followed —
 * `worker` splits its run into `test:unit` and `test:db`, and both halves carry
 * globs. Cycles and unknown names resolve to nothing rather than looping.
 */
function resolveTestScript(scripts, name = 'test', seen = new Set()) {
  if (seen.has(name)) return ''
  seen.add(name)
  const script = scripts[name]
  if (typeof script !== 'string') return ''
  return script.replaceAll(
    /\bpnpm(?:\s+run)?\s+([\w:-]+)/g,
    (match, referenced) => resolveTestScript(scripts, referenced, seen) || match,
  )
}

/** Every glob argument the script hands its runner, unquoted. */
function globsIn(script) {
  return [...script.matchAll(/(?:"([^"]+)"|'([^']+)'|(\S+))/g)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter((token) => /\.test\.tsx?$/.test(token))
}

/**
 * The directory a glob is rooted at: everything before its first wildcard
 * segment. `test/**\/*.test.ts` → `test`, `src/__tests__/*.test.ts` →
 * `src/__tests__`, `*.test.ts` → `` (the package root).
 */
function globRoot(glob) {
  const segments = glob.split('/')
  const wildcard = segments.findIndex((segment) => segment.includes('*'));
  return (wildcard === -1 ? segments.slice(0, -1) : segments.slice(0, wildcard)).join('/')
}

const directories = packageDirectories()
const files = testFiles()
const violations = []
const unchecked = []
let checkedPackages = 0
let checkedFiles = 0

for (const directory of directories) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const scripts = manifest.scripts ?? {}
  // A package's own files, never a nested package's — `packages/foo` must not
  // be judged by `packages/foo/bar`'s script.
  const owned = files.filter(
    (file) =>
      file.startsWith(`${directory}/`)
      && !directories.some(
        (other) => other !== directory && other.startsWith(`${directory}/`) && file.startsWith(`${other}/`),
      ),
  )
  if (owned.length === 0) continue

  if (typeof scripts.test !== 'string') {
    unchecked.push(`${directory} (${owned.length} test file(s), no test script)`)
    continue
  }
  const script = resolveTestScript(scripts)
  const globs = globsIn(script)
  if (globs.length === 0) {
    const runner = SELF_DISCOVERING.find((name) => script.includes(name))
    unchecked.push(
      `${directory} (${owned.length} test file(s), ${runner ? `${runner} discovers its own` : 'no glob in its test script'})`,
    )
    continue
  }

  const roots = [...new Set(globs.map(globRoot))]
  checkedPackages += 1
  checkedFiles += owned.length
  for (const file of owned) {
    const relative = file.slice(directory.length + 1)
    const covered = roots.some((root) => root === '' || relative.startsWith(`${root}/`))
    if (!covered) {
      violations.push(
        `${file} is not run by ${manifest.name ?? directory}'s test script, which globs ${roots
          .map((root) => `${root}/`)
          .join(', ')}`,
      )
    }
  }
}

if (violations.length > 0) {
  fail(
    [
      'These test files exist but no test script runs them, so they pass review and',
      'then never execute — locally or in CI.',
      '',
      ...violations,
      '',
      "Move each file under a directory its package's `test` script globs, or widen",
      'that glob to name where the file lives. Colocating tests with source is fine;',
      'a package globbing one place and writing tests in another is not.',
    ].join('\n'),
  )
}

console.log(
  `lint-test-globs: ${checkedFiles} test file(s) across ${checkedPackages} package(s) are covered by their test script`
  + (unchecked.length > 0 ? `; not checkable: ${unchecked.join(', ')}` : ''),
)
