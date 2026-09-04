import { useEffect } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import { Wikilink } from './wikilink/wikilink-node'
import { WidgetEmbedEditing } from './widget-embed/WidgetEmbedView'
import { WikilinkSuggestion } from './wikilink/wikilink-suggestion'
import { WikilinkSuggestionMenu } from './wikilink/WikilinkSuggestionMenu'

type RichTextEditorProps = {
  onChange: (html: string) => void
  placeholder?: string
  value: string
}

type ToolbarButtonProps = {
  active?: boolean
  label: string
  onClick: () => void
  title: string
}

const ToolbarButton = ({ active, label, onClick, title }: ToolbarButtonProps) => (
  <button
    className={[
      'min-w-[28px] rounded px-2 py-1 text-xs font-semibold',
      active
        ? 'bg-[color:var(--accent)] text-[var(--on-accent)]'
        : 'text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)] hover:text-[var(--tx)]',
    ].join(' ')}
    // Keep the editor selection while clicking toolbar buttons.
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
    title={title}
    type="button"
  >
    {label}
  </button>
)

const Toolbar = ({ editor }: { editor: Editor }) => {
  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('Link URL', previous ?? 'https://')
    if (url === null) return
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run()
  }

  return (
    <div className="kb-editor-toolbar flex flex-wrap items-center gap-1 border-b border-[color:var(--sep)] py-2">
      <ToolbarButton
        active={editor.isActive('bold')}
        label="B"
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold"
      />
      <ToolbarButton
        active={editor.isActive('italic')}
        label="I"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic"
      />
      <span className="mx-1 h-4 w-px bg-[color:var(--sep)]" />
      <ToolbarButton
        active={editor.isActive('heading', { level: 1 })}
        label="H1"
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        title="Heading 1"
      />
      <ToolbarButton
        active={editor.isActive('heading', { level: 2 })}
        label="H2"
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        title="Heading 2"
      />
      <span className="mx-1 h-4 w-px bg-[color:var(--sep)]" />
      <ToolbarButton
        active={editor.isActive('bulletList')}
        label="•"
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Bullet list"
      />
      <ToolbarButton
        active={editor.isActive('orderedList')}
        label="1."
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Numbered list"
      />
      <ToolbarButton
        active={editor.isActive('blockquote')}
        label="❝"
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title="Quote"
      />
      <span className="mx-1 h-4 w-px bg-[color:var(--sep)]" />
      <ToolbarButton
        active={editor.isActive('code')}
        label="‹›"
        onClick={() => editor.chain().focus().toggleCode().run()}
        title="Inline code"
      />
      <ToolbarButton
        active={editor.isActive('codeBlock')}
        label="{ }"
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        title="Code block"
      />
      <ToolbarButton
        active={editor.isActive('link')}
        label="🔗"
        onClick={setLink}
        title="Link"
      />
      <ToolbarButton
        label="[[ ]]"
        onClick={() => editor.chain().focus().insertContent('[[').run()}
        title="Link page"
      />
    </div>
  )
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
      {editor ? <Toolbar editor={editor} /> : null}
      <EditorContent className="min-h-0 flex-1 py-4" editor={editor} />
      {editor ? <WikilinkSuggestionMenu editor={editor} /> : null}
    </div>
  )
}
