#!/usr/bin/env node

// Durable local state never lives inside the checkout.
//
// Every working tree under `.worktrees/` and `.claude/worktrees/` is temporary
// by design, and AGENTS.md tells every agent to remove its own once the branch
// merges. Anything a person cannot afford to lose therefore has to sit outside
// the tree — otherwise routine cleanup deletes it.
//
// This is not hypothetical. The local Postgres kept its cluster at
// `../../.nessie/docker/postgres`, a bind mount into whichever tree started it.
// On 2026-09-18 that tree was removed after its branch merged, the data
// directory went with it, the container stopped, and the next start ran initdb
// into the empty directory. The entire local install was gone. The filesystem
// blob store had the same shape and a second failure mode besides: resolved
// against the working directory, it was per-tree, while the database every tree
// talks to is shared — so rows written from one checkout named bytes no other
// checkout could read ("Markdown attachment bytes not found").
//
// The rule, and the one-time migration, are in docs/standards/local-state.md.
//
// Generated fixtures are exempt and listed below: a test certificate rebuilt on
// every run loses nothing when its directory disappears.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Checkout-relative paths that hold nothing anyone would miss. */
const REGENERATED_FIXTURES = [
  // Self-signed certificates the mail-agent harness writes before each run.
  '.nessie/mail-agent-e2e',
]

const problems = []
const checked = []

const read = (relative) => {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8')
  } catch {
    return null
  }
}

/**
 * A Compose service that keeps state must do it in a named volume. A bind
 * mount whose source is relative points back into the checkout.
 */
const checkComposeVolumes = (relative) => {
  const text = read(relative)
  if (text === null) return
  checked.push(relative)
  for (const [index, line] of text.split('\n').entries()) {
    const mount = /^\s*-\s+([^\s#]+):(\/[^\s:#]+)/.exec(line)
    if (!mount) continue
    const [, source, destination] = mount
    if (!source.startsWith('.') && !source.startsWith('/')) continue // named volume
    if (REGENERATED_FIXTURES.some((fixture) => source.includes(fixture))) continue
    problems.push(
      `${relative}:${index + 1} binds ${destination} to "${source}", inside the checkout.`
      + ' Use a named volume with an explicit `name:` instead.',
    )
  }
}

/**
 * A named volume without an explicit `name:` is prefixed with the Compose
 * project name, which Compose derives from the directory it was invoked from —
 * so each working tree would quietly get a volume of its own.
 */
const checkVolumeNamesArePinned = (relative) => {
  const text = read(relative)
  if (text === null) return
  const block = /\nvolumes:\n((?:[ \t]+.*\n|\n)*)/.exec(text)
  if (!block) return
  const declarations = [...block[1].matchAll(/^ {2}([\w.-]+):$/gm)].map((match) => match[1])
  for (const declaration of declarations) {
    const body = new RegExp(`^ {2}${declaration}:\n(?: {4}.*\n|\n)*`, 'm').exec(block[1])
    if (body && / {4}name:\s*\S/.test(body[0])) continue
    problems.push(
      `${relative}: volume "${declaration}" has no explicit \`name:\`, so Compose`
      + ' prefixes it with the project name — one volume per working tree.',
    )
  }
}

/** The local blob store has to outlive the tree the API was started from. */
const checkStorageDefaults = () => {
  const targets = [
    ['packages/config/src/config-loader.ts', /const LOCAL_STORAGE_PATH = (.+)$/m],
    ['packages/runtime/src/storage/index.ts', /const DEFAULT_LOCAL_PATH = (.+)$/m],
  ]
  for (const [relative, pattern] of targets) {
    const text = read(relative)
    if (text === null) {
      problems.push(`${relative} is missing; this gate can no longer check it.`)
      continue
    }
    checked.push(relative)
    const match = pattern.exec(text)
    if (!match) {
      problems.push(
        `${relative} no longer declares the local storage default this gate reads.`
        + ' Keep the constant, or update scripts/lint-local-state-paths.mjs with it.',
      )
      continue
    }
    if (!match[1].includes('homedir()')) {
      problems.push(
        `${relative} sets the local storage path to ${match[1].trim()}, which is not`
        + ' anchored outside the checkout. Build it from `homedir()`.',
      )
    }
  }
}

checkComposeVolumes('infrastructure/compose/docker-compose.yml')
checkComposeVolumes('infrastructure/compose/docker-compose.mail-agent-e2e.yml')
checkVolumeNamesArePinned('infrastructure/compose/docker-compose.yml')
checkStorageDefaults()

if (problems.length > 0) {
  console.error('lint-local-state-paths: durable local state must live outside the checkout.')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('  See docs/standards/local-state.md.')
  process.exit(1)
}

console.log(
  `lint-local-state-paths: ${checked.length} local-state definition(s) anchored outside the checkout`
  + ` (${REGENERATED_FIXTURES.length} regenerated fixture path(s) exempt)`,
)
