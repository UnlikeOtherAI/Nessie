import { useEffect, type RefObject } from 'react'
import { applyConcealedFenceEdit } from '../lib/markdown-editor'

// React synthesises its own `onBeforeInput`, which carries no `inputType`, so
// the Markdown editors listen for the real event: it is the only place an edit
// can still be redirected before the browser commits it to the wrong side of a
// concealed delimiter.
export const useConcealedFenceInput = (
  editorRef: RefObject<HTMLElement | null>,
  onEdit: (text: string) => void,
): void => {
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const handle = (event: InputEvent) => {
      const text = applyConcealedFenceEdit(editor, event.inputType, event.data)
      if (text === null) return
      event.preventDefault()
      onEdit(text)
    }

    editor.addEventListener('beforeinput', handle)
    return () => editor.removeEventListener('beforeinput', handle)
  }, [editorRef, onEdit])
}
