import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// The step-15 source-regex gates (docs/navigation/overview.md §11 "Gates", plan
// docs/done/2026-09-01-navigation-motion-system.md §4.18): the shapes the
// script/ESLint gates cannot express precisely enough belong here instead.
// Each allowlist is a plain list a later commit deletes lines from as the
// parallel conversion work lands elsewhere — never a flag day, never grown
// back once a file leaves it.

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('stack containers clip rather than hide, so no descendant can scroll them', () => {
  // A hidden-overflow box is still a scroll container: TabBar's mount-time
  // scrollIntoView() inside a screen parked at translate3d(100%) scrolled the
  // viewport sideways, and the compositor landed the slide short by that
  // offset until the next layout clamped it — the "bounce". `clip` is not a
  // scroll container. Reproduction: docs/done/2026-09-01-navigation-motion-system/repro.mjs
  // Moved from admin/test/phone-navigation-transition.test.ts — this is a
  // step-15 gate, not a transition-suite pin.
  const styles = readSource('../src/styles.css')
  const viewportRule = styles.slice(
    styles.indexOf('.phone-navigation-viewport {'),
    styles.indexOf('.phone-navigation-page {'),
  )
  assert.match(viewportRule, /\.phone-navigation-viewport \{[\s\S]*?overflow: clip;/)
  assert.match(viewportRule, /\.phone-navigation-screen \{[\s\S]*?overflow: clip;/)
  assert.doesNotMatch(viewportRule, /overflow: hidden/)

  const shell = readSource('../src/layouts/AdminShellLayout.tsx')
  assert.match(shell, /<main\s+className="min-w-0 flex-1 overflow-clip/)

  const columnBrowser = readSource(
    '../src/components/shared/column-browser/ColumnBrowserViewport.tsx',
  )
  assert.match(columnBrowser, /<div className="h-full w-full overflow-clip">/)
  assert.equal(
    (columnBrowser.match(/<div className="h-full w-full overflow-clip">/g) ?? []).length,
    2,
    'both the stacked and the track branch clip',
  )

  const tabBar = readSource('../src/components/primitives/TabBar.tsx')
  assert.doesNotMatch(tabBar, /\.scrollIntoView\(/)
  assert.match(tabBar, /track\.scrollLeft/)
})

// Every navigation-owned motion runs on runStackTransition's Web Animations
// timeline (docs/navigation/overview.md §3), never a CSS keyframe or an in-rule
// `transition`. `admin/test/phone-navigation-transition.test.ts` already
// pins the phone-navigation-* keyframe count at zero from the motion side;
// this gate is the general one, covering both prefixes plus the in-rule
// transition check the plan's §4.18 table lists separately.
const NAVIGATION_KEYFRAME_ALLOWLIST = [
  // Knowledge's folder/document/history/editor are still their own routed
  // views, not yet NestedStage adopters (docs/navigation/overview.md §6, "Adopters …
  // in progress"): KnowledgeFilesystemBrowser.tsx and KnowledgeColumns.tsx
  // still apply this class. Delete this entry in the same change that
  // deletes admin/src/styles.css's `kb-view-slide` keyframe and
  // `.animate-kb-view-slide` rule.
  'kb-view-slide',
]

test('no new navigation-motion keyframes or transitions on a stack layer', () => {
  const styles = readSource('../src/styles.css')

  const keyframeNames = [...styles.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1])
  const navigationKeyframes = keyframeNames.filter((name) => /^(phone-navigation|kb-view)/.test(name))
  const unexpectedKeyframes = navigationKeyframes.filter(
    (name) => !NAVIGATION_KEYFRAME_ALLOWLIST.includes(name),
  )
  assert.deepEqual(
    unexpectedKeyframes,
    [],
    'A new phone-navigation-*/kb-view-* @keyframes reintroduces CSS-driven '
      + 'motion; runStackTransition (docs/navigation/overview.md §3) is the only mover.',
  )

  // Every `.phone-navigation-<name>` (and its combinator variants, e.g.
  // `.phone-navigation-screen--underlay > .phone-navigation-dim`) rule body,
  // matched non-greedily so one rule's `}` never swallows the next.
  const ruleBodies = [...styles.matchAll(/\.phone-navigation-[\w-]+(?:\s*[>,][^{]*)?\s*\{([^}]*)\}/g)]
    .map((match) => match[1])
  assert.ok(ruleBodies.length > 0, 'expected at least one .phone-navigation-* rule in styles.css')
  for (const body of ruleBodies) {
    assert.doesNotMatch(
      body,
      /\btransition\s*:/,
      'A `transition:` inside a .phone-navigation-* rule fights '
        + "runStackTransition's own Web Animations timeline — see docs/navigation/overview.md §3.",
    )
  }
})

// Every centred/edge-anchored overlay composes the shared work useOverlay()
// does once — Back registration, focus trap/Escape, the drag-safe scrim
// dismiss, the layer and its motion (docs/navigation/overview.md §7) — either
// directly or through one of the primitives already built on it. A bespoke
// `role="dialog"` is exactly the fifty-overlays-disagreeing defect the hook
// replaced.
const BESPOKE_DIALOG_ALLOWLIST = [
  'admin/src/components/features/billing/UoaBillingRecurringAddonsPanel.tsx',
  'admin/src/components/features/channels/ChannelMessageActions.tsx',
  'admin/src/components/features/channels/SecretCaptureDialog.tsx',
  'admin/src/components/features/knowledge/comments/CommentActions.tsx',
  'admin/src/layouts/admin-shell/NativeSearchOverlay.tsx',
]

const SANCTIONED_OVERLAY_USAGE = /<Dialog|<ConfirmDialog|<Sheet|<Popover|useOverlay\(/

test('every role="dialog" surface composes the shared overlay primitives', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  const tracked = execSync("git ls-files 'admin/src/*.tsx'", { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const violations: string[] = []
  for (const file of tracked) {
    const content = readFileSync(`${repoRoot}/${file}`, 'utf8')
    if (!content.includes('role="dialog"')) continue
    if (SANCTIONED_OVERLAY_USAGE.test(content)) continue
    if (BESPOKE_DIALOG_ALLOWLIST.includes(file)) continue
    violations.push(file)
  }

  assert.deepEqual(
    violations,
    [],
    'A role="dialog" surface must render Dialog/ConfirmDialog/Sheet/Popover or '
      + 'call useOverlay() directly — see docs/navigation/overview.md §7, or allowlist it '
      + 'in admin/test/navigation-gates.test.ts while the conversion is in flight.',
  )

  // The allowlist itself only ever shrinks: every entry must still be a real,
  // tracked, currently-unconverted offender, or it is dead weight hiding a
  // future regression.
  for (const file of BESPOKE_DIALOG_ALLOWLIST) {
    assert.ok(tracked.includes(file), `${file} is allowlisted but no longer tracked`)
    const content = readFileSync(`${repoRoot}/${file}`, 'utf8')
    assert.ok(
      content.includes('role="dialog"') && !SANCTIONED_OVERLAY_USAGE.test(content),
      `${file} no longer needs its navigation-gates allowlist entry — delete the line`,
    )
  }
})
