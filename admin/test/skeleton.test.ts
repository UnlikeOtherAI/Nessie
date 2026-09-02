import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Skeleton, SkeletonBlock } from '../src/components/primitives/Skeleton.js'

// Step 10 of docs/done/2026-09-01-navigation-motion-system.md (§4.10),
// docs/navigation.md §"Arriving with content".

// The production Vite transform injects the JSX runtime; node's tsx loader uses
// the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

test('every page-type variant renders a shell', () => {
  for (const variant of ['board', 'detail', 'feed', 'list'] as const) {
    const markup = renderToStaticMarkup(createElement(Skeleton, { variant }))
    assert.match(markup, new RegExp(`data-skeleton="${variant}"`), variant)
    assert.match(markup, /animate-pulse/, `${variant} shimmers`)
    // A placeholder has nothing to read out; it announces busy and no content.
    assert.match(markup, /aria-busy="true"/, variant)
    assert.doesNotMatch(markup, /[A-Za-z]{3,}<\/(?:div|span)>/, `${variant} carries no text`)
  }
})

test('count decides the number of rows, and detail ignores it', () => {
  const rows = (markup: string) => (markup.match(/rounded-full/g) ?? []).length
  assert.equal(rows(renderToStaticMarkup(createElement(Skeleton, { count: 2, variant: 'list' }))), 2)
  assert.equal(rows(renderToStaticMarkup(createElement(Skeleton, { count: 5, variant: 'list' }))), 5)
  assert.equal(
    renderToStaticMarkup(createElement(Skeleton, { count: 9, variant: 'detail' })),
    renderToStaticMarkup(createElement(Skeleton, { variant: 'detail' })),
  )
})

test('SkeletonBlock is one shimmering rectangle the caller sizes', () => {
  const markup = renderToStaticMarkup(
    createElement(SkeletonBlock, { className: 'h-32 rounded-lg' }),
  )
  assert.match(markup, /animate-pulse/)
  assert.match(markup, /h-32 rounded-lg/)
  assert.match(markup, /aria-hidden="true"/)
})

// One skeleton, one token. Before this, three unrelated systems answered "still
// loading" on two different greys — `--overlay` in the agents table and the
// project sections, `--overlay-weak` in the app cards, a bare `--panel`
// rectangle on a dashboard tile — so the same fact looked different depending
// on which screen you landed on.
const PULSE_ALLOWLIST = [
  // Not skeletons: both pulse a *live* status, which is content, not a
  // placeholder for content.
  'admin/src/components/features/workflow-designer/WorkflowCanvasNode.tsx',
  'admin/src/components/features/apps/ConnectProgress.tsx',
]

test('no file outside Skeleton.tsx declares shimmer markup of its own', () => {
  const tracked = execSync("git ls-files 'admin/src/*'", { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const violations: string[] = []
  for (const file of tracked) {
    if (file === 'admin/src/components/primitives/Skeleton.tsx') continue
    if (PULSE_ALLOWLIST.includes(file)) continue
    if (!/\.tsx?$/.test(file)) continue
    if (readFileSync(`${repoRoot}/${file}`, 'utf8').includes('animate-pulse')) {
      violations.push(file)
    }
  }

  assert.deepEqual(
    violations,
    [],
    'A loading placeholder is <Skeleton variant=…> or <SkeletonBlock> — see '
      + 'docs/navigation.md §"Arriving with content".',
  )
})

// A sibling swap (channel A → B, page A → B) keeps the previous entity on
// screen until the new one arrives rather than flashing empty. The obligation
// sits on the query: a facade read that waits for an id, or is keyed by one,
// is a screen's content and must say so.
const KEEP_PREVIOUS_EXEMPT = [
  // Billing is scoped per UOA org/team and must never reuse another team's
  // projection across an active-team switch (see lib/query-keys.ts).
  'src/facades/billing/hooks.ts',
]

test('every per-id facade query keeps its previous data', () => {
  const files = execSync("git ls-files 'admin/src/facades/*'", { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\.tsx?$/.test(line))

  const violations: string[] = []
  for (const file of files) {
    if (KEEP_PREVIOUS_EXEMPT.includes(file.replace('admin/', ''))) continue
    const source = readFileSync(`${repoRoot}/${file}`, 'utf8')
    for (const match of source.matchAll(/useQuery\s*(?:<[\s\S]*?>)?\s*\(\s*\{/g)) {
      const start = match.index + match[0].length - 1
      let depth = 0
      let end = start
      for (let index = start; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1
        else if (source[index] === '}') {
          depth -= 1
          if (depth === 0) {
            end = index
            break
          }
        }
      }
      const body = source.slice(start, end + 1)
      const idKeyed = /queryKey:[^\n]*\([^)]*\w*[Ii]d\b/.test(body)
      const idGated = /enabled:[^\n]*Boolean\(/.test(body)
      if (!idKeyed && !idGated) continue
      if (body.includes('placeholderData')) continue
      violations.push(`${file}:${source.slice(0, match.index).split('\n').length}`)
    }
  }

  assert.deepEqual(
    violations,
    [],
    'A useQuery keyed by, or gated on, an entity id must pass '
      + '`placeholderData: keepPreviousData` — see docs/navigation.md '
      + '§"Arriving with content".',
  )
})
