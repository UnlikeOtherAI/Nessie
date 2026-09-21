import assert from 'node:assert/strict'

/**
 * Where an overlay's markup is, now that overlays leave the page tree.
 *
 * Every overlay renders through `components/overlays/OverlayPortal.tsx` into
 * one host on the document, so a mount's own container never holds it: its
 * layer has to be compared at the root stacking context, and its
 * `position: fixed` has to mean the viewport, neither of which survives an
 * ancestor that isolates, clips or transforms (docs/navigation/overview.md §7).
 *
 * A suite that mounts an overlay therefore reads it from here rather than from
 * the element it rendered into.
 */
export const overlayHostIn = (doc: Document): HTMLElement => {
  const host = doc.querySelector('.admin-overlay-root')
  assert.ok(host, 'no overlay rendered: OverlayPortal\'s host is not on the document')
  return host as HTMLElement
}

/**
 * The topmost overlay's outermost element — a scrim, a panel or an anchored
 * surface — inside its `.admin-overlay-slot`, the per-overlay wrapper that
 * hides an overlay while its screen is covered.
 */
export const openOverlayIn = (doc: Document): HTMLElement => {
  const host = overlayHostIn(doc)
  const slot = host.lastElementChild
  assert.ok(slot, 'the overlay host is empty: nothing is open')
  assert.ok(slot.classList.contains('admin-overlay-slot'), 'every overlay renders in its own slot')
  const overlay = slot.firstElementChild
  assert.ok(overlay, 'the overlay slot is empty')
  return overlay as HTMLElement
}
