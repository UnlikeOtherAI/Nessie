import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import Placeholder from '@tiptap/extension-placeholder'
import StarterKit from '@tiptap/starter-kit'
import { Popover } from '../../overlays/Popover'
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

const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  ({ active, label, onClick, title }, ref) => (
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
      ref={ref}
      title={title}
      type="button"
    >
      {label}
    </button>
  ),
)
ToolbarButton.displayName = 'ToolbarButton'

// The link URL popover: an inline input anchored to the toolbar's Link
// button, replacing a `window.prompt` that had no keyboard-consistent styling
// and no theming. Enter applies (clearing the link on an empty URL), Escape
// cancels without touching the editor's link mark.
const LinkToolbarButton = ({ editor }: { editor: Editor }) => {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!open) return undefined
    const focus = window.setTimeout(() => inputRef.current?.select(), 0)
    return () => window.clearTimeout(focus)
  }, [open])

  const openPopover = () => {
    const previous = editor.getAttributes('link').href as string | undefined
    setDraft(previous ?? 'https://')
    setOpen(true)
  }

  const apply = () => {
    const url = draft.trim()
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
    }
    setOpen(false)
  }

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      apply()
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <>
      <ToolbarButton
        active={editor.isActive('link')}
        label="🔗"
        onClick={openPopover}
        ref={anchorRef}
        title="Link"
      />
      <Popover
        anchorRef={anchorRef}
        className="rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-2 shadow-lg"
        label="Link URL"
        onClose={() => setOpen(false)}
        open={open}
        placement="bottom-start"
        role="dialog"
      >
        <input
          className="admin-input w-64"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="https://"
          ref={inputRef}
          value={draft}
        />
      </Popover>
    </>
  )
}

const Toolbar = ({ editor }: { editor: Editor }) => {
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
      <LinkToolbarButton editor={editor} />
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
