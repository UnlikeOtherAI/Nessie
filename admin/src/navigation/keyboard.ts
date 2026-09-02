import { useEffect } from 'react'

// docs/navigation/overview.md §11/§4.14 — the soft keyboard. `visualViewport` shrinks
// by roughly the keyboard's height when it opens (the layout viewport,
// `window.innerHeight`, does not), so the gap between the two is the inset
// to keep the active composer above. One listener for the whole shell:
// every composer container reads the same custom property
// (`padding-bottom: var(--keyboard-inset, 0px)`) rather than each one
// polling `visualViewport` on its own.
export const KEYBOARD_INSET_PROPERTY = '--keyboard-inset'

// Below this a `visualViewport` delta is browser chrome — the URL bar
// hiding, a few px of rounding — not a keyboard opening.
const KEYBOARD_MIN_INSET_PX = 60

const measureInset = (win: Window): number => {
  const viewport = win.visualViewport
  if (!viewport) return 0
  const inset = win.innerHeight - viewport.height - viewport.offsetTop
  return inset >= KEYBOARD_MIN_INSET_PX ? Math.round(inset) : 0
}

// Exported separately from the hook so a jsdom test can drive it without
// mounting React (the settle.ts pattern: pure DOM logic, then a thin effect).
export const attachKeyboardInsetListener = (win: Window = window): (() => void) => {
  const viewport = win.visualViewport
  const root = win.document.documentElement
  const apply = (): void => {
    root.style.setProperty(KEYBOARD_INSET_PROPERTY, `${measureInset(win)}px`)
  }

  if (!viewport) {
    apply()
    return () => {}
  }

  apply()
  viewport.addEventListener('resize', apply)
  viewport.addEventListener('scroll', apply)
  return () => {
    viewport.removeEventListener('resize', apply)
    viewport.removeEventListener('scroll', apply)
    root.style.setProperty(KEYBOARD_INSET_PROPERTY, '0px')
  }
}

// Mounted once in the shell (AdminShellLayout) — never per composer.
export const useKeyboardInset = (): void => {
  useEffect(() => attachKeyboardInsetListener(window), [])
}
