#!/usr/bin/env node

// Viewport arbitrary-variant gate
// (docs/plans/2026-08-13-responsive-coherence.md §A/§B, Phase 6): a viewport
// breakpoint number is authored once, in styles.css's @theme static block, and
// TSX must use the named scale (`md:`, `max-xl:`) or the useViewport store.
// Arbitrary VIEWPORT variants (`min-[Npx]:` / `max-[Npx]:`) are rejected across
// admin/src. CONTAINER queries (`@min-[…]:` / `@max-[…]:`) stay legal — they
// respond to the allocation a component actually receives, which is the plan's
// rule C.2 and not a restatement of the viewport scale. The thread panel's
// 900px family is allowlisted in place: it is a decided, panel-local token
// (plan §E) pending the named `--breakpoint-panel` conversion, and it is the
// only surviving viewport literal family.

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SCAN_ROOT = 'admin/src'

// file path (repo-relative) → allowed arbitrary viewport variant prefixes.
const ALLOWLIST = new Map([
  [
    'admin/src/components/features/channels/thread-panel/ThreadReplyPanel.tsx',
    ['min-[900px]', 'max-[900px]'],
  ],
])

// Arbitrary viewport width variant: `min-[Npx]` / `max-[Npx]`, optionally
// stacked (`min-[900px]:max-xl:`) or !-important prefixed. Container variants
// start with `@` and are explicitly excluded; a digit or letter immediately
// before `min`/`max` (e.g. `@min`, `xmax`) is not a variant boundary.
const VIEWPORT_VARIANT = /(?<![@\w])(min|max)-\[(\d+(?:\.\d+)?)px\]/g

function fail(message) {
  console.error(message)
  process.exit(1)
}

function trackedFiles() {
  const output = execSync(`git ls-files '${SCAN_ROOT}/*.ts' '${SCAN_ROOT}/*.tsx'`, {
    encoding: 'utf8',
  })
  // Uncommitted deletions stay in the index until staged; only files that
  // still exist on disk are scanned.
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => fs.existsSync(path.resolve(process.cwd(), file)))
}

const violations = []

for (const file of trackedFiles()) {
  const content = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')
  const lines = content.split('\n')
  const allowed = ALLOWLIST.get(file) ?? []
  lines.forEach((line, index) => {
    for (const match of line.matchAll(VIEWPORT_VARIANT)) {
      const variant = `${match[1]}-[${match[2]}px]`
      if (allowed.includes(variant)) continue
      violations.push(`${file}:${index + 1} uses arbitrary viewport variant '${variant}'`)
    }
  })
}

if (violations.length > 0) {
  fail(
    [
      'Arbitrary viewport min-[Npx]/max-[Npx] variants are not allowed in admin/src.',
      'Use the named Tailwind scale (md:/max-xl:) or the useViewport store; a new',
      'viewport width number belongs in the styles.css @theme static block, not in',
      'a class string. Container @min-[...]/@max-[...] variants stay legal.',
      'See docs/plans/2026-08-13-responsive-coherence.md §A/§B (Phase 6).',
      '',
      ...violations,
    ].join('\n'),
  )
}

console.log(`lint-breakpoints: ${trackedFiles().length} admin files clean`)
