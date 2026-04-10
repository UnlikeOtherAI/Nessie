import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type MentionEntity = {
  id: string
  name: string
  type: 'user' | 'agent'
  glyph?: string
}

export type MentionInputHandle = {
  clear: () => void
  focus: () => void
  getText: () => string
  insertAtSign: () => void
}

type Props = {
  entities: MentionEntity[]
  onChange?: (text: string) => void
  onSubmit: (text: string) => void
  placeholder: string
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function extractText(node: Node): string {
  let out = ''
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? ''
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement
      if (el.dataset.mentionId) {
        out += el.textContent ?? ''
      } else if (el.tagName === 'BR') {
        out += '\n'
      } else {
        out += extractText(el)
      }
    }
  }
  return out
}

function clearChildren(el: HTMLElement): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild)
  }
}

function getMentionContext(): { query: string; range: Range } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null

  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0)
  if (node.nodeType !== Node.TEXT_NODE) return null

  const text = (node.textContent ?? '').slice(0, offset)
  const match = text.match(/(^|[\s\u00A0])@([^\s\u00A0]*)$/)
  if (!match) return null

  const query = match[2] ?? ''
  const atPos = offset - query.length - 1

  const range = document.createRange()
  range.setStart(node, atPos)
  range.setEnd(node, offset)
  return { query, range }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const MentionInput = forwardRef<MentionInputHandle, Props>(
  ({ entities, onChange, onSubmit, placeholder }, ref) => {
    const editorRef = useRef<HTMLDivElement>(null)
    const popupRef = useRef<HTMLDivElement>(null)
    const [mentionQuery, setMentionQuery] = useState<string | null>(null)
    const [selectedIdx, setSelectedIdx] = useState(0)
    const [hasContent, setHasContent] = useState(false)

    const filtered = useMemo(
      () =>
        mentionQuery !== null
          ? entities.filter((e) =>
              e.name.toLowerCase().includes(mentionQuery.toLowerCase()),
            )
          : [],
      [entities, mentionQuery],
    )

    const filteredRef = useRef(filtered)
    filteredRef.current = filtered

    const selectedIdxRef = useRef(selectedIdx)
    selectedIdxRef.current = selectedIdx

    // Clamp selected index when filtered list shrinks
    useEffect(() => {
      if (filtered.length > 0 && selectedIdx >= filtered.length) {
        setSelectedIdx(filtered.length - 1)
      }
    }, [filtered.length, selectedIdx])

    // Scroll selected item into view
    useEffect(() => {
      const popup = popupRef.current
      if (!popup) return
      const item = popup.children[selectedIdx] as HTMLElement | undefined
      item?.scrollIntoView({ block: 'nearest' })
    }, [selectedIdx])

    const showPopup = mentionQuery !== null && filtered.length > 0

    const sync = useCallback(() => {
      const el = editorRef.current
      if (!el) return
      const text = extractText(el)
      setHasContent(text.trim().length > 0)
      onChange?.(text)
    }, [onChange])

    const checkMention = useCallback(() => {
      const ctx = getMentionContext()
      if (ctx) {
        setMentionQuery(ctx.query)
        setSelectedIdx(0)
      } else {
        setMentionQuery(null)
      }
    }, [])

    const insertMention = useCallback(
      (entity: MentionEntity) => {
        const ctx = getMentionContext()
        if (!ctx) {
          setMentionQuery(null)
          return
        }

        const sel = window.getSelection()
        if (!sel) return

        sel.removeAllRanges()
        sel.addRange(ctx.range)
        sel.deleteFromDocument()

        const span = document.createElement('span')
        span.contentEditable = 'false'
        span.dataset.mentionId = entity.id
        span.dataset.mentionType = entity.type
        span.className = 'mention-tag'
        span.textContent = `@${entity.name}`

        const range = sel.getRangeAt(0)
        range.insertNode(span)

        const space = document.createTextNode('\u00A0')
        span.after(space)

        const cursor = document.createRange()
        cursor.setStartAfter(space)
        cursor.collapse(true)
        sel.removeAllRanges()
        sel.addRange(cursor)

        setMentionQuery(null)
        sync()
      },
      [sync],
    )

    const insertMentionRef = useRef(insertMention)
    insertMentionRef.current = insertMention

    useImperativeHandle(ref, () => ({
      clear() {
        const el = editorRef.current
        if (!el) return
        clearChildren(el)
        setHasContent(false)
        setMentionQuery(null)
        onChange?.('')
      },
      focus() {
        editorRef.current?.focus()
      },
      getText() {
        return editorRef.current ? extractText(editorRef.current) : ''
      },
      insertAtSign() {
        const el = editorRef.current
        if (!el) return
        el.focus()
        document.execCommand('insertText', false, '@')
      },
    }))

    return (
      <div className="relative" style={{ isolation: 'isolate' }}>
        {showPopup ? (
          <div
            ref={popupRef}
            className={[
              'absolute bottom-full left-0 z-50 mb-1 max-h-[200px] w-[260px]',
              'overflow-y-auto rounded-lg border border-[color:var(--sep)]',
              'bg-[color:var(--main)] shadow-xl',
            ].join(' ')}
          >
            {filtered.map((entity, i) => (
              <button
                key={entity.id}
                className={[
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                  i === selectedIdx
                    ? 'bg-[color:var(--accent)] text-white'
                    : 'text-[color:var(--tx)] hover:bg-white/5',
                ].join(' ')}
                onMouseDown={(e) => {
                  e.preventDefault()
                  insertMentionRef.current(entity)
                }}
                onMouseEnter={() => setSelectedIdx(i)}
                type="button"
              >
                <span
                  className={[
                    'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full',
                    'bg-white/10 text-xs',
                  ].join(' ')}
                >
                  {entity.type === 'agent'
                    ? (entity.glyph ?? '⚡')
                    : (entity.name[0]?.toUpperCase() ?? '?')}
                </span>
                <span className="truncate">{entity.name}</span>
                <span className="ml-auto flex-shrink-0 text-xs opacity-50">
                  {entity.type}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <div
          ref={editorRef}
          className={[
            'mention-editor min-h-[82px] w-full bg-transparent px-4 py-3 text-sm',
            'text-[#f3f4f6] outline-none',
            !hasContent ? 'is-empty' : '',
          ].join(' ')}
          contentEditable
          data-placeholder={placeholder}
          onBlur={() => {
            // Delay so mouseDown on popup fires first
            setTimeout(() => setMentionQuery(null), 150)
          }}
          onInput={() => {
            sync()
            checkMention()
          }}
          onKeyDown={(e) => {
            const f = filteredRef.current
            const idx = selectedIdxRef.current

            if (mentionQuery !== null && f.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedIdx((idx + 1) % f.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedIdx((idx - 1 + f.length) % f.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                const entity = f[idx]
                if (!entity) {
                  return
                }
                insertMentionRef.current(entity)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMentionQuery(null)
                return
              }
            }

            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              const editor = editorRef.current
              if (!editor) return
              const text = extractText(editor).trim()
              if (!text) return
              // Clear synchronously BEFORE notifying the caller so a second
              // Enter keystroke can't re-read the same text.
              clearChildren(editor)
              setHasContent(false)
              setMentionQuery(null)
              onChange?.('')
              onSubmit(text)
            }
          }}
          onPaste={(e) => {
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            document.execCommand('insertText', false, text)
          }}
          role="textbox"
          suppressContentEditableWarning
        />
      </div>
    )
  },
)

MentionInput.displayName = 'MentionInput'
