import { useEffect } from 'react'

/**
 * What somebody is typing, **before they commit it**.
 *
 * This is the difference between "presence" and "collaboration": a selection
 * rectangle says a peer is in B4, and a draft says they are about to make it
 * 1 200 — which is what stops the other person typing 900 into it.
 *
 * IronCalc's cell editor is a real `<textarea>` inside
 * `.ic-worksheet-editor-wrapper` (the formula bar has its own, inside
 * `.ic-formula-bar-editor-wrapper`, editing the same cell). Neither the
 * editing text nor the editing cell is on the model — they live in
 * `WorkbookState`, which is private to the widget — so the honest way to read
 * a draft is the DOM, from the outside, exactly as it is rendered.
 *
 * That reach-in is the one in this feature, and it is deliberately shallow: it
 * reads `value` off a textarea and nothing else, it never writes, and if the
 * selector stops matching in a future release the draft simply stops being
 * published. Nothing else breaks — which is the property that makes it
 * acceptable where patching the widget would not be.
 *
 * The *cell* comes from the model's selected view rather than from the DOM,
 * because IronCalc opens the editor on the selected cell and keeps them in
 * step; reading a second source would let the two disagree.
 */

export const CELL_EDITOR_SELECTOR =
  '.ic-worksheet-editor-wrapper textarea, .ic-formula-bar-editor-wrapper textarea'

/** Keys that end an edit one way or another. Escape cancels, the rest commit. */
const CLOSING_KEYS = new Set(['Enter', 'Escape', 'Tab'])

export const useDraftObserver = (input: {
  /** The pane subtree the editor lives in. */
  host: HTMLElement | null
  enabled: boolean
  /** The current text, or null when nothing is being edited. */
  onDraft: (text: string | null) => void
}): void => {
  const { enabled, host, onDraft } = input

  useEffect(() => {
    if (!enabled || !host) return undefined

    const isEditor = (target: EventTarget | null): target is HTMLTextAreaElement =>
      target instanceof HTMLTextAreaElement && target.matches(CELL_EDITOR_SELECTOR)

    const onInput = (event: Event): void => {
      if (!isEditor(event.target)) return
      onDraft(event.target.value)
    }

    // Capture, like the pane's own Escape and Ctrl-F handlers: the widget
    // stops these inside React's root while the grid has focus, which is
    // exactly when somebody is typing into a cell.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isEditor(event.target)) return
      if (CLOSING_KEYS.has(event.key)) onDraft(null)
    }

    const onBlur = (event: FocusEvent): void => {
      if (!isEditor(event.target)) return
      onDraft(null)
    }

    host.addEventListener('input', onInput, true)
    host.addEventListener('keydown', onKeyDown, true)
    host.addEventListener('focusout', onBlur, true)
    return () => {
      host.removeEventListener('input', onInput, true)
      host.removeEventListener('keydown', onKeyDown, true)
      host.removeEventListener('focusout', onBlur, true)
      // A pane that goes away while somebody was typing must not leave their
      // draft painted on every peer's grid until it expires.
      onDraft(null)
    }
  }, [enabled, host, onDraft])
}
