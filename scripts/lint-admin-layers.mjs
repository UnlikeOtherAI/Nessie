#!/usr/bin/env node

// Layer-direction gate (docs/provider-system-and-frontend-architecture.md §5.4):
// admin/src is ten ordered layers, and an import may only run downward.
// Modelled on scripts/lint-layers.mjs — same shape, same shrinking-allowlist
// contract: every entry below is a real offender at the time this gate landed.
// Delete a line the moment its edge is inverted; never add one back. Inverting
// the dependency (moving the shared symbol down) is always the fix; an
// allowlist entry is the admission that a move is not available yet, and it
// carries the reason.

import fs from 'node:fs'
import path from 'node:path'

const SCAN_ROOT = 'admin/src'

// Longest-prefix wins, so 'components/shared' beats 'components'.
// `bridges` sits with `providers`: a bridge renders nothing, it wires an
// outside system (the native shell, the desktop app, the notification centre)
// to the same layers a provider may read.
const LAYERS = [
  ['lib', ['lib']],
  ['hooks', ['lib', 'hooks']],
  ['navigation', ['lib', 'hooks', 'providers', 'navigation']],
  ['facades', ['lib', 'hooks', 'providers', 'facades']],
  ['providers', ['lib', 'hooks', 'facades', 'navigation', 'components/overlays', 'providers', 'bridges']],
  ['bridges', ['lib', 'hooks', 'facades', 'navigation', 'components/overlays', 'providers', 'bridges']],
  ['components/primitives', ['lib', 'components/primitives']],
  ['components/overlays', ['lib', 'hooks', 'navigation', 'components/primitives', 'components/overlays']],
  [
    'components/shared',
    [
      'lib',
      'hooks',
      'navigation',
      'facades',
      'providers',
      'components/primitives',
      'components/overlays',
      'components/shared',
    ],
  ],
  [
    'components',
    [
      // features/: everything above, plus the three component layers.
      'lib',
      'hooks',
      'navigation',
      'facades',
      'providers',
      'components/primitives',
      'components/overlays',
      'components/shared',
      'components',
    ],
  ],
  ['layouts', ['lib', 'hooks', 'navigation', 'facades', 'providers', 'bridges', 'components/primitives', 'components/overlays', 'components/shared', 'components', 'layouts']],
  ['pages', ['*']],
  ['', ['*']], // router.tsx, main.tsx, styles
]

// Edges that are correct despite running upward, each with its reason.
// A named exception, never a general edge (docs/navigation/content-and-drafts.md §14).
const EXCEPTIONS = new Map([
  // §14 requires prewarm to call the exact `fetch*` the destination's hook
  // calls; a copy inside navigation/ would be the second fetcher
  // admin/test/prewarm.test.ts pins against.
  ['admin/src/navigation/prewarm.ts', ['facades']],
  // AppProvider is the composition root: it mounts the router and the desktop
  // window frame *under* the providers, which is what a root does.
  ['admin/src/providers/AppProvider.tsx', ['layouts', '']],
])

// Every entry is a real offending edge today, with the reason it is not a move.
const ALLOWLIST = new Map([
  [
    'admin/src/navigation/PhoneNavigationButton.tsx -> admin/src/layouts/admin-shell/PhoneNavigationProvider',
    'The doorway renders the controller\'s decision; the controller itself mounts the shell (NativePhoneNavigationBridge) and stays in layouts.',
  ],
  [
    'admin/src/navigation/PhoneNavigationButton.tsx -> admin/src/layouts/admin-shell/ShellStateContext',
    'The same doorway opens the shell\'s section menu at a tab root — shell state, read by the one component that renders it.',
  ],
  [
    'admin/src/components/features/channels/useReplyThread.ts -> admin/src/layouts/admin-shell/PhoneNavigationProvider',
    'The reply panel closes through the phone controller\'s Back; same controller-in-layouts reason as the doorway above.',
  ],
  [
    'admin/src/components/primitives/TabBar.tsx -> admin/src/components/overlays/Popover',
    'The overflow menu. docs/standards/design-system.md names TabBar at the primitive path, so the popover comes to it rather than the file moving.',
  ],
  [
    'admin/src/providers/IncomingCallProvider.tsx -> admin/src/components/shared/IncomingCallDialog',
    'A viewport-mount composition: the provider is the ring\'s only host and mounts its one surface, like ToastProvider mounts CardViewport.',
  ],
  [
    'admin/src/bridges/DirectDesktopUpdatePrompt.tsx -> admin/src/components/shared/Dialog',
    'Same viewport-mount shape: the desktop update bridge mounts one dialog and renders nothing else.',
  ],
  [
    'admin/src/providers/AgentIdentityProvider.tsx -> admin/src/components/shared/agent-identity',
    'The identity shape the provider publishes is declared beside its consumers; the type, not a component.',
  ],
  [
    'admin/src/components/shared/ResponsivePageHeader.tsx -> admin/src/layouts/admin-shell/ShellStateContext',
    'The one header renders the shell\'s account menu and mobile nav on the phone; that state is the shell\'s and has no lower home.',
  ],
])

const layerOf = (rel) => {
  let best = ''
  for (const [layer] of LAYERS) {
    if (layer && rel.startsWith(`${layer}/`) && layer.length > best.length) best = layer
  }
  return best
}
const allowedFrom = (layer) => LAYERS.find(([name]) => name === layer)?.[1] ?? ['*']

const QUOTED = /(['"])(\.\.?\/[^'"\n]*)\1/g

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      sourceFiles(full, out)
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path.relative(ROOT, full))
    }
  }
  return out
}

const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
const resolveSpecifier = (fromRel, spec) => {
  const bare = spec.endsWith('.js') ? spec.slice(0, -3) : spec
  const base = path.resolve(ROOT, path.dirname(fromRel), bare)
  for (const extension of EXTENSIONS) {
    const candidate = base + extension
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(ROOT, candidate).replace(/\.tsx?$/, '')
    }
  }
  return null
}

const violations = []
const seen = new Set()
let scanned = 0

for (const file of sourceFiles(path.join(ROOT, SCAN_ROOT)).sort()) {
  scanned += 1
  const rel = file.slice(`${SCAN_ROOT}/`.length)
  const from = layerOf(rel)
  const allowed = allowedFrom(from)
  const extra = EXCEPTIONS.get(file) ?? []
  const content = fs.readFileSync(path.join(ROOT, file), 'utf8')
  QUOTED.lastIndex = 0
  let match
  while ((match = QUOTED.exec(content))) {
    const resolved = resolveSpecifier(file, match[2])
    if (!resolved || !resolved.startsWith(`${SCAN_ROOT}/`)) continue
    const to = layerOf(resolved.slice(`${SCAN_ROOT}/`.length))
    if (to === from) continue
    if (allowed.includes('*') || allowed.includes(to) || extra.includes(to)) continue
    const edge = `${file} -> ${resolved}`
    if (ALLOWLIST.has(edge)) {
      seen.add(edge)
      continue
    }
    violations.push(`${edge}   (${from || 'root'} may not import ${to || 'root'})`)
  }
}

const stale = [...ALLOWLIST.keys()].filter((edge) => !seen.has(edge))
if (stale.length > 0) {
  console.error(
    [
      'These allowlisted edges no longer exist. Delete the lines — the list only shrinks.',
      '',
      ...stale,
    ].join('\n'),
  )
  process.exit(1)
}

if (violations.length > 0) {
  console.error(
    [
      'admin/src imports must run downward through the layer order.',
      'See docs/provider-system-and-frontend-architecture.md §5.4 and the LAYERS table in this script.',
      'Invert the dependency (move the shared symbol down) rather than allowlisting a new edge.',
      '',
      ...violations,
    ].join('\n'),
  )
  process.exit(1)
}

console.log(`lint-admin-layers: ${scanned} files clean (${ALLOWLIST.size} allowlisted edges)`)
