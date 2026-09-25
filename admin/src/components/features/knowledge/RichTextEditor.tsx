import { useEffect } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import { RichTextToolbar, ToolbarButton } from '../../shared/markdown-editor/RichTextToolbar'
import { Wikilink } from './wikilink/wikilink-node'
import { WidgetEmbedEditing } from './widget-embed/WidgetEmbedView'
import { WikilinkSuggestion } from './wikilink/wikilink-suggestion'
import { WikilinkSuggestionMenu } from './wikilink/WikilinkSuggestionMenu'

type RichTextEditorProps = {
  onChange: (html: string) => void
  placeholder?: string
  value: string
}

export const RichTextEditor = ({ onChange, placeholder, value }: RichTextEditorProps) => {
  const editor = useEditor({
    content: value,
    editorProps: {
      attributes: { class: 'kb-prose focus:outline-none' },
    },
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      Placeholder.configure({ placeholder: placeholder ?? 'Write something…' }),
      Wikilink,
      WikilinkSuggestion,
      // A chip while editing: a live chart fights the cursor.
      WidgetEmbedEditing,
    ],
    immediatelyRender: false,
    onUpdate: ({ editor: instance }) => onChange(instance.getHTML()),
  })

  // Reset content when the editor is pointed at a different page.
  useEffect(() => {
    if (!editor) return
    if (value !== editor.getHTML()) {
      editor.commands.setContent(value, { emitUpdate: false })
    }
  }, [editor, value])

  return (
    <div className="kb-editor flex min-h-0 flex-1 flex-col">
      {editor ? (
        <RichTextToolbar
          editor={editor}
          headingLevels={[1, 2]}
          trailing={(
            <ToolbarButton
              label="[[ ]]"
              onClick={() => editor.chain().focus().insertContent('[[').run()}
              title="Link document"
            />
          )}
        />
      ) : null}
      <EditorContent className="min-h-0 flex-1 py-4" editor={editor} />
      {editor ? <WikilinkSuggestionMenu editor={editor} /> : null}
    </div>
  )
}
