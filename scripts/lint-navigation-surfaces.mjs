#!/usr/bin/env node

// Surface-registry totality gate
// (docs/done/2026-09-01-navigation-motion-system.md §4.1/§4.18, step 3):
// every route declared in `admin/src/router.tsx` must resolve to a row in
// the navigation surface registry, or be one of the few screens the
// registry itself lists as outside the navigation stack
// (`OUTSIDE_STACK_PATHS`: login, bootstrap, the external-auth completion and
// the not-found catch-all).
//
// Why a gate: the registry replaced an `admin:detail` catch-all that silently
// swallowed every unclassified admin route. A route added without a row would
// simply stop animating, lose its Back destination and render outside the
// retained stack — a defect that shows up only on a phone, months later. The
// lint reads the router and registry modules as text (no TypeScript loader),
// so it runs anywhere `node` does; `admin/test/navigation-surfaces-total.test.ts` runs the same
// extraction against the real, executed registry.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const ROUTER_FILE = 'admin/src/router.tsx'
const SURFACE_FILES = [
  'admin/src/navigation/surfaces.ts',
  'admin/src/navigation/admin-surfaces.ts',
  'admin/src/navigation/connected-mail-surfaces.ts',
]

const readRepoFile = (relativePath) =>
  fs.readFileSync(path.resolve(REPO_ROOT, relativePath), 'utf8')

const isIdentifierStart = (char) => /[A-Za-z_$]/.test(char)
const isIdentifierPart = (char) => /[A-Za-z0-9_$]/.test(char)

// Reads the string literal starting at `start`, returning its value and the
// index just past its closing quote. Only what router.tsx contains: single,
// double and backtick literals with backslash escapes, no interpolation.
const readStringLiteral = (source, start) => {
  const quote = source[start]
  let value = ''
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      value += source[index + 1] ?? ''
      index += 2
      continue
    }
    if (char === quote) return { next: index + 1, value }
    value += char
    index += 1
  }
  return { next: source.length, value }
}

const joinRoutePath = (parent, literal) => {
  if (literal.startsWith('/')) return literal
  if (!parent) return literal
  return `${parent === '/' ? '' : parent}${`/${literal}`}`
}

// Every `path:` literal declared in the router, with nested child paths
// joined onto the path of the route object whose `children` array holds them.
// A tiny brace/bracket scanner rather than a regex, because `path: 'new'` and
// `path: ':channelId/info'` only mean anything relative to `/channels`.
export const collectRouterPaths = (source) => {
  const paths = []
  const stack = []
  let pendingKey = null
  let index = 0

  const nearestObject = () => {
    for (let position = stack.length - 1; position >= 0; position -= 1) {
      if (stack[position].kind === 'object') return stack[position]
    }
    return null
  }
  const nearestArrayParent = () => {
    for (let position = stack.length - 1; position >= 0; position -= 1) {
      if (stack[position].kind === 'array') return stack[position].parent
    }
    return null
  }

  while (index < source.length) {
    const char = source[index]

    if (char === '/' && source[index + 1] === '/') {
      const lineEnd = source.indexOf('\n', index)
      index = lineEnd === -1 ? source.length : lineEnd + 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const blockEnd = source.indexOf('*/', index + 2)
      index = blockEnd === -1 ? source.length : blockEnd + 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const { next, value } = readStringLiteral(source, index)
      index = next
      if (pendingKey === 'path') {
        const resolved = joinRoutePath(nearestArrayParent(), value)
        const owner = nearestObject()
        if (owner) owner.path = resolved
        paths.push(resolved)
      }
      pendingKey = null
      continue
    }
    if (char === '{') {
      stack.push({ kind: 'object', path: null })
      pendingKey = null
      index += 1
      continue
    }
    if (char === '[') {
      const owner = nearestObject()
      stack.push({
        kind: 'array',
        parent: pendingKey === 'children' && owner ? owner.path : null,
      })
      pendingKey = null
      index += 1
      continue
    }
    if (char === '}' || char === ']') {
      stack.pop()
      pendingKey = null
      index += 1
      continue
    }
    if (isIdentifierStart(char)) {
      let end = index
      while (end < source.length && isIdentifierPart(source[end])) end += 1
      const identifier = source.slice(index, end)
      let lookahead = end
      while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead += 1
      if (source[lookahead] === ':') {
        pendingKey = identifier
        index = lookahead + 1
      } else {
        index = end
      }
      continue
    }
    index += 1
  }

  return paths
}

// The `pattern:` regex literals, read out of the registry source. Character
// classes are consumed whole so an unescaped `/` inside `[^/]` cannot be
// mistaken for the literal's terminator.
const REGEX_LITERAL = /pattern:\s*\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+)\/([a-z]*)/g

export const collectSurfacePatterns = (source) =>
  [...source.matchAll(REGEX_LITERAL)].map(([, body, flags]) => new RegExp(body, flags))

export const collectOutsideStackPaths = (source) => {
  const declaration = source.match(/OUTSIDE_STACK_PATHS\s*=\s*\[([^\]]*)\]/)
  if (!declaration) return []
  return [...declaration[1].matchAll(/'([^']*)'/g)].map(([, value]) => value)
}

// A router path is a pattern with `:params`; the registry matches concrete
// pathnames, so each parameter becomes one opaque segment.
export const toSamplePathname = (routerPath) =>
  routerPath.replace(/:[A-Za-z0-9_]+/g, 'sample-id')

const main = () => {
  const routerSource = readRepoFile(ROUTER_FILE)
  const surfacesSource = SURFACE_FILES.map(readRepoFile).join('\n')
  const patterns = collectSurfacePatterns(surfacesSource)
  const outside = new Set(collectOutsideStackPaths(surfacesSource))
  const routerPaths = collectRouterPaths(routerSource)

  if (routerPaths.length === 0) {
    console.error(`lint-navigation-surfaces: no route paths found in ${ROUTER_FILE}`)
    process.exit(1)
  }
  if (patterns.length === 0) {
    console.error(
      `lint-navigation-surfaces: no surface patterns found in ${SURFACE_FILES.join(', ')}`,
    )
    process.exit(1)
  }

  const unclassified = routerPaths.filter((routerPath) => {
    if (outside.has(routerPath)) return false
    const sample = toSamplePathname(routerPath)
    return !patterns.some((pattern) => pattern.test(sample))
  })

  if (unclassified.length > 0) {
    console.error(
      [
        'Every route in admin/src/router.tsx must resolve to a row in',
        'admin/src/navigation/surfaces.ts (or be listed in OUTSIDE_STACK_PATHS).',
        'A route with no row renders outside the navigation stack: no push, no',
        'pop, no Back destination. See docs/navigation/overview.md §4.',
        '',
        ...unclassified.map((routerPath) => `  ${routerPath} has no surface row`),
      ].join('\n'),
    )
    process.exit(1)
  }

  console.log(
    `lint-navigation-surfaces: ${routerPaths.length} router paths classified by `
    + `${patterns.length} surface rows`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
