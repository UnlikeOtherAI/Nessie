import { useEffect, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Minimal modal a11y for a panel rendered as `role="dialog" aria-modal="true"`:
 * moves focus into the panel on mount, traps Tab within it, closes on Escape,
 * and restores focus to the previously-focused element on unmount. The panel
 * element should carry `tabIndex={-1}` so it can receive focus when it has no
 * focusable children yet.
 */
export const useModalA11y = (
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void => {
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) {
      return
    }
    const previouslyFocused = document.activeElement as HTMLElement | null

    const focusables = (): HTMLElement[] =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.offsetParent !== null,
      )

    ;(focusables()[0] ?? panel).focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        // A modal owns Escape exclusively: without this, the same keypress
        // also reaches window-level listeners (e.g. the reply panel's
        // close-on-Escape) and dismisses the surface under the dialog.
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') {
        return
      }
      const items = focusables()
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) {
        event.preventDefault()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    panel.addEventListener('keydown', onKeyDown)
    return () => {
      panel.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [panelRef, onClose])
}
