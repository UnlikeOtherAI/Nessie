import { useEffect } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'

// Read-only renderer for stored page HTML. Parsing through the ProseMirror
// schema drops scripts, event handlers and unknown tags, so stored HTML cannot
// execute — the content never reaches the DOM as a raw HTML string.
export const RichTextContent = ({ html }: { html: string }) => {
  const editor = useEditor({
    content: html,
    editable: false,
    editorProps: { attributes: { class: 'kb-prose' } },
    extensions: [StarterKit.configure({ link: { openOnClick: true } })],
    immediatelyRender: false,
  })

  useEffect(() => {
    if (editor && html !== editor.getHTML()) {
      editor.commands.setContent(html, { emitUpdate: false })
    }
  }, [editor, html])

  return <EditorContent editor={editor} />
}
