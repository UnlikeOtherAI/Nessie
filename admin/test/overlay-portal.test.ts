import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The portal rule, enforced instead of documented.
 *
 * An overlay's layer (`navigation/overlay.ts`) only decides who wins inside one
 * stacking context. Left where it is declared, an overlay inherits every
 * ancestor between it and the document — and the admin's page path has all
 * three hazards: `main` clips, `.phone-navigation-viewport` isolates, and
 * `.phone-navigation-screen` is a positioned, clipped layer that carries a
 * transform for the whole of a stack transition. Any one of them takes the
 * viewport away as the containing block or traps the layer below the shell's
 * own chrome, and the result is a dialog whose scrim covers the content column
 * only: the rail and the secondary sidebar stay unblurred and paint over the
 * panel, which is then cut off at the sidebar's edge.
 *
 * So every overlay renders through `OverlayPortal`. This walks `src` and holds
 * each `useOverlay` consumer to that, exactly — a new overlay that forgets the
 * portal fails, and so does an entry here that no longer needs to be one.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url))

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

type Consumer = { path: string; portals: boolean }

const consumers: Consumer[] = []
for (const path of walk(SRC).filter((file) => file.endsWith('.tsx'))) {
  const source = readFileSync(path, 'utf8')
  if (!/\buseOverlay\(/.test(source)) continue
  consumers.push({
    path: `src/${relative(SRC, path)}`,
    portals: /<OverlayPortal[\s/>]/.test(source),
  })
}

test('the scan finds the admin\'s overlays at all', () => {
  // A detector that matched nothing would make the assertion below vacuous,
  // which is how this class of test rots.
  assert.ok(consumers.length >= 10, `expected the admin's overlays, found ${consumers.length}`)
  for (const primitive of [
    'src/components/shared/Dialog.tsx',
    'src/components/overlays/Sheet.tsx',
    'src/components/overlays/Popover.tsx',
  ]) {
    assert.ok(consumers.some((c) => c.path === primitive), `${primitive} must be in the scanned set`)
  }
})

test('every overlay renders through OverlayPortal', () => {
  const offenders = consumers.filter((consumer) => !consumer.portals).map((c) => c.path)
  assert.deepEqual(
    offenders,
    [],
    'these compose useOverlay but render in the page tree, where an ancestor decides '
    + 'their layer and their containing block — wrap the returned tree in <OverlayPortal>',
  )
})

/**
 * The one `active={false}` in the codebase, and why it is not a loophole:
 * `ChannelConversationComposePage` is a Flow, not a modal. On `single` it is a
 * real screen in the phone navigation stack and must travel with its layer; it
 * registers `useOverlay` only on `split`, where it visually is a centred dialog
 * (docs/navigation/overview.md §7).
 */
test('only the Flow that is a real screen on single opts out of the portal', () => {
  const optOuts = consumers
    .filter((consumer) => /<OverlayPortal active=/.test(readFileSync(join(SRC, '..', consumer.path), 'utf8')))
    .map((consumer) => consumer.path)
  assert.deepEqual(optOuts, ['src/pages/ChannelConversationComposePage.tsx'])
})
