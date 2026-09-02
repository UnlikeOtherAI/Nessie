#!/usr/bin/env node

// Layer-scale gate (docs/navigation/overview.md §7, plan §4.18, step 15): the
// overlay/stack layer scale is declared exactly twice — the `--layer-*`
// custom properties in styles.css's `:root` block and the mirrored
// `OVERLAY_LAYER` object in admin/src/navigation/overlay.ts — and every
// stacking context in admin/src reads one of those two, via
// `var(--layer-<kind>)` in CSS/Tailwind or `OVERLAY_LAYER[kind]` /
// `useOverlay()`'s `layerStyle` in TS/TSX. A literal z-index (a Tailwind
// `z-[n]`/`z-N` utility, an inline `zIndex:` number, or a raw `z-index:`
// CSS declaration) reintroduces exactly the "fifty overlays disagreeing on
// stacking order" problem the scale replaced. Modelled on
// scripts/lint-breakpoints.mjs.

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SCAN_ROOT = 'admin/src'

// file path (repo-relative) → allowlisted while the parallel overlay/layer
// conversion is in flight. Every entry here is a real offender at the time
// this gate landed (`grep -rnE "z-\\[[0-9]+\\]|\\bz-[0-9]+\\b|zIndex:|z-index:"
// admin/src`, minus the false positives the detection below already resolves
// on its own — a TS type position and a `var(--layer-…)` value need no
// allowlist entry because they are not literal z-index values). Delete a
// line the moment its file's last real offense is converted to the scale;
// never add a line back once the file is off this list. Never grows past
// this seed — a later commit only shrinks it, toward empty.
const ALLOWLIST = new Set([
  'admin/src/components/features/apps/AppCard.tsx',
  'admin/src/components/features/apps/AppIconBadge.tsx',
  'admin/src/components/features/apps/AppsToolbar.tsx',
  'admin/src/components/features/billing/UoaBillingRecurringAddonsPanel.tsx',
  'admin/src/components/features/channels/ConversationInfoFlow.tsx',
  'admin/src/components/features/channels/DocumentTargetBar.tsx',
  'admin/src/components/features/channels/SecretCaptureDialog.tsx',
  'admin/src/components/features/channels/thread-panel/ThreadReplyPanel.tsx',
  'admin/src/components/features/integrations/DeepWaterResearchLauncherDialog.tsx',
  'admin/src/components/features/knowledge/FileVersionUploadDialog.tsx',
  'admin/src/components/features/knowledge/notes/PageNotesLayer.tsx',
  'admin/src/components/features/knowledge/wikilink/WikilinkCreateConfirm.tsx',
  'admin/src/components/features/workflow-designer/WorkflowCanvas.tsx',
  'admin/src/components/features/workflow-designer/WorkflowCanvasNode.tsx',
  'admin/src/components/kanban/ArchiveDoneMenu.tsx',
  'admin/src/components/shared/DropZoneOverlay.tsx',
  'admin/src/components/shared/EditProjectDialog.tsx',
  'admin/src/components/shared/LoginSessionImportButton.tsx',
  'admin/src/components/shared/MentionInput.tsx',
  'admin/src/layouts/admin-shell/NativeIPadToolbarBridge.tsx',
  'admin/src/layouts/admin-shell/ProjectsSidebarNav.tsx',
  'admin/src/layouts/admin-shell/SidebarProjectsSection.tsx',
  'admin/src/layouts/admin-shell/UserMenuTrigger.tsx',
  'admin/src/layouts/admin-shell/WorkspaceSwitcher.tsx',
  'admin/src/pages/ChannelConversationComposePage.tsx',
  'admin/src/pages/DashboardDetailPage.tsx',
  'admin/src/providers/ExternalAuthProvider.tsx',
  'admin/src/styles.css',
])

// Tailwind arbitrary bracket utility: z-[9999]. A word/hyphen character
// immediately before "z-[" excludes it (never matches inside a longer token).
const TAILWIND_BRACKET = /(?<![\w-])z-\[(\d+)\]/g
// Tailwind named-scale utility: z-40, z-50, … A leading `\b` keeps this off
// the tail of an unrelated identifier ("xz-40" cannot start a match at "z").
const TAILWIND_UTILITY = /\bz-(\d+)\b/g
// An inline React/DOM style property with a literal numeric value. A
// `var(--layer-…)` value or a bare type position (`zIndex: string`) has no
// digit immediately after the colon, so neither matches here — no separate
// allowlist exemption is needed for either.
const ZINDEX_PROP = /\bzIndex\s*:\s*(-?\d+)/g
// A raw CSS z-index declaration with a literal numeric value; `z-index:
// var(--layer-modal);` is excluded the same way.
const ZINDEX_CSS = /z-index\s*:\s*(-?\d+)/g

const PATTERNS = [TAILWIND_BRACKET, TAILWIND_UTILITY, ZINDEX_PROP, ZINDEX_CSS]

// The one legal source of a layer number in styles.css: the `--layer-*`
// custom-property declarations themselves (mirrored in
// admin/src/navigation/overlay.ts `OVERLAY_LAYER`, never restated here).
const LAYER_TOKEN_DECLARATION = /^\s*--layer-[\w-]+\s*:/

function fail(message) {
  console.error(message)
  process.exit(1)
}

function trackedFiles() {
  const output = execSync(
    `git ls-files '${SCAN_ROOT}/*.ts' '${SCAN_ROOT}/*.tsx' '${SCAN_ROOT}/*.css'`,
    { encoding: 'utf8' },
  )
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => fs.existsSync(path.resolve(process.cwd(), file)))
}

function lineViolations(file, line) {
  // A declaration of the scale itself is never a violation.
  if (file === 'admin/src/styles.css' && LAYER_TOKEN_DECLARATION.test(line)) return []
  // A value that reads the scale (CSS var or the mirrored JS map) is never a
  // violation, wherever it appears.
  if (line.includes('var(--layer-')) return []

  const hits = []
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(line))) {
      hits.push(match[0].trim())
    }
  }
  return hits
}

const violations = []
let scanned = 0

for (const file of trackedFiles()) {
  scanned += 1
  const content = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')
  const lines = content.split('\n')
  const allowed = ALLOWLIST.has(file)
  lines.forEach((line, index) => {
    const hits = lineViolations(file, line)
    if (hits.length === 0) return
    if (allowed) return
    for (const hit of hits) {
      violations.push(`${file}:${index + 1} declares a literal layer value '${hit}'`)
    }
  })
}

if (violations.length > 0) {
  fail(
    [
      'Literal z-index values are not allowed in admin/src.',
      "Use the layer scale: styles.css's var(--layer-<kind>) in CSS/Tailwind,",
      "or OVERLAY_LAYER[kind] / useOverlay()'s layerStyle in TS/TSX. See",
      'docs/navigation/overview.md §7 and admin/src/navigation/overlay.ts.',
      '',
      ...violations,
    ].join('\n'),
  )
}

console.log(`lint-layers: ${scanned} admin files clean (${ALLOWLIST.size} allowlisted)`)
