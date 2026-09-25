import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import type { Editor } from '@tiptap/react'
import {
  faBold,
  faCode,
  faFileCode,
  faHeading,
  faImage,
  faItalic,
  faLink,
  faListOl,
  faListUl,
  faQuoteLeft,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Popover } from '../../overlays/Popover'

type ToolbarButtonProps = {
  /** Set for a toggle (a mark or a block type); omitted for a one-shot action. */
  active?: boolean
  disabled?: boolean
  /** The visible icon for the action. */
  label: ReactNode
  onClick: () => void
  title: string
}

/**
 * One toolbar control. `title` is also the accessible name — the visible
 * label is an icon, while the button keeps the channel composer's compact shape.
 */
export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  ({ active, disabled, label, onClick, title }, ref) => (
    <button
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      className={[
        'admin-compose-action flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx3)]',
        active
          ? 'bg-[color:var(--accent)] text-[var(--on-accent)]'
          : 'hover:bg-[var(--overlay)] hover:text-[var(--tx)]',
      ].join(' ')}
      disabled={disabled}
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

export const ToolbarDivider = () => <span className="mx-1 h-4 w-px bg-[color:var(--sep)]" />

const isModK = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k'

// The link URL popover: an inline input anchored to the toolbar's Link
// button, replacing a `window.prompt` that had no keyboard-consistent styling
// and no theming. Enter applies (clearing the link on an empty URL), Escape
// cancels without touching the editor's link mark.
const LinkToolbarButton = ({ editor, shortcut }: { editor: Editor; shortcut: boolean }) => {
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
  const openRef = useRef(openPopover)
  openRef.current = openPopover

  // Cmd/Ctrl+K from inside the text opens the same popover.
  useEffect(() => {
    if (!shortcut) return undefined
    const dom = editor.view.dom
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isModK(event)) return
      event.preventDefault()
      openRef.current()
    }
    dom.addEventListener('keydown', onKeyDown)
    return () => dom.removeEventListener('keydown', onKeyDown)
  }, [editor, shortcut])

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
        label={<FontAwesomeIcon className="h-4 w-4" icon={faLink} />}
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
          aria-label="Link URL"
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

/** The picker behind the Image button; several files insert in order. */
const ImageToolbarButton = ({ onPickImages }: { onPickImages: (files: File[]) => void }) => {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <ToolbarButton label={<FontAwesomeIcon icon={faImage} />} onClick={() => inputRef.current?.click()} title="Image" />
      <input
        accept="image/*"
        aria-hidden="true"
        className="hidden"
        data-testid="markdown-editor-image-input"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          // Reset so picking the same file again still fires `change`.
          event.target.value = ''
          if (files.length > 0) onPickImages(files)
        }}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />
    </>
  )
}

export type RichTextToolbarProps = {
  className?: string
  editor: Editor
  /** Levels offered as buttons: the knowledge editor keeps H1/H2, Markdown fields H2/H3. */
  headingLevels?: readonly (1 | 2 | 3)[]
  /** Cmd/Ctrl+K opens the link popover from inside the text. */
  linkShortcut?: boolean
  /** Shows the Image button; the picked files go here. */
  onPickImages?: (files: File[]) => void
  /** Editor-specific controls after the shared ones — the knowledge wikilink button. */
  trailing?: ReactNode
}

/**
 * The formatting row shared by the knowledge page editor and every Markdown
 * field (ticket description, comments). One row of the same controls in the
 * same order, so a person who learned one editor has learned both.
 */
export const RichTextToolbar = ({
  className = 'kb-editor-toolbar flex flex-wrap items-center gap-1 border-b border-[color:var(--sep)] py-2',
  editor,
  headingLevels = [1, 2],
  linkShortcut = false,
  onPickImages,
  trailing,
}: RichTextToolbarProps) => (
  <div aria-label="Formatting" className={className} role="toolbar">
    <ToolbarButton
      active={editor.isActive('bold')}
      label={<FontAwesomeIcon className="h-4 w-4" icon={faBold} />}
      onClick={() => editor.chain().focus().toggleBold().run()}
      title="Bold"
    />
    <ToolbarButton
      active={editor.isActive('italic')}
      label={<FontAwesomeIcon className="h-4 w-4" icon={faItalic} />}
      onClick={() => editor.chain().focus().toggleItalic().run()}
      title="Italic"
    />
    <ToolbarDivider />
    {headingLevels.map((level) => (
      <ToolbarButton
        active={editor.isActive('heading', { level })}
        key={level}
        label={(
          <>
            <FontAwesomeIcon className="h-4 w-4" icon={faHeading} />
            <span className="-ml-0.5 text-[9px] font-semibold leading-none">{level}</span>
          </>
        )}
        onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
        title={`Heading ${level}`}
      />
    ))}
    <ToolbarDivider />
    <ToolbarButton
      active={editor.isActive('bulletList')}
      label={<FontAwesomeIcon className="h-4 w-4" icon={faListUl} />}
      onClick={() => editor.chain().focus().toggleBulletList().run()}
      title="Bullet list"
    />
    <ToolbarButton
      active={editor.isActive('orderedList')}
      label={<FontAwesomeIcon className="h-4 w-4" icon={faListOl} />}
      onClick={() => editor.chain().focus().toggleOrderedList().run()}
      title="Numbered list"
    />
    <ToolbarButton
      active={editor.isActive('blockquote')}
      label={<FontAwesomeIcon className="h-4 w-4" icon={faQuoteLeft} />}
      onClick={() => editor.chain().focus().toggleBlockquote().run()}
      title="Quote"
    />
    <ToolbarDivider />
    <ToolbarButton
      active={editor.isActive('code')}
      label={<FontAwesomeIcon className="h-4 w-4" icon={faCode} />}
      onClick={() => editor.chain().focus().toggleCode().run()}
      title="Inline code"
    />
    <ToolbarButton
      active={editor.isActive('codeBlock')}
      label={<FontAwesomeIcon className="h-4 w-4" icon={faFileCode} />}
      onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      title="Code block"
    />
    <LinkToolbarButton editor={editor} shortcut={linkShortcut} />
    {onPickImages ? <ImageToolbarButton onPickImages={onPickImages} /> : null}
    {trailing}
  </div>
)
