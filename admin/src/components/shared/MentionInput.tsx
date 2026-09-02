import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  decorateMarkdownEditor,
  extractEditorText,
  insertMarkdownEditorText,
} from '../../lib/markdown-editor'
import { useConcealedFenceInput } from '../../hooks/useConcealedFenceInput'
import {
  readPersonalAssistantMentions,
  type PersonalAssistantMention,
} from './mention-input-personal-assistant'
import { IdentityTile } from '../primitives/IdentityTile'
import { UserAvatar } from '../primitives/UserAvatar'
import { AgentAvatar } from './AgentAvatar'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type MentionEntity = {
  detail?: string
  glyph?: string
  id: string
  // The canonical token to put in message content. A PA owner sees a friendly
  // label in the picker, but everyone stores the same public form.
  insertName?: string
  name: string
  // Present only for a PA presence. Together with `id` this is the structural
  // address sent with the message, never a display-name inference.
  principalUserId?: string
  trigger: '@' | '#'
  type: 'user' | 'agent' | 'channel'
}

export type { PersonalAssistantMention } from './mention-input-personal-assistant'

export type MentionInputHandle = {
  clear: () => void
  focus: () => void
  getAgentMentions: () => PersonalAssistantMention[]
  getText: () => string
  insertAtSign: () => void
  insertHashSign: () => void
  insertText: (text: string) => void
  /**
   * Replaces the whole editor content — how a restored draft is put back.
   * Deliberately does NOT focus: a draft restored on mount must not steal the
   * caret, and `decorateMarkdownEditor` only restores a cursor that was
   * already inside this editor.
   */
  setText: (text: string) => void
}

type Props = {
  entities: MentionEntity[]
  maxLength?: number
  onChange?: (text: string) => void
  onOversizePaste?: (paste: string) => void
  onSubmit: (text: string, agentMentions: PersonalAssistantMention[]) => void
  placeholder: string
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function clearChildren(el: HTMLElement): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild)
  }
}

function getLastTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return node as Text
  }

  for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
    const child = node.childNodes[i]
    if (!child) continue
    const textNode = getLastTextNode(child)
    if (textNode) return textNode
  }

  return null
}

function getSelectionTextNode(
  editor: HTMLElement,
  node: Node,
  offset: number,
): { node: Text; offset: number } | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return { node: node as Text, offset }
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return null
  if (!editor.contains(node)) return null

  const element = node as HTMLElement
  const before = element.childNodes[offset - 1]
  const beforeText = before ? getLastTextNode(before) : null
  if (beforeText) {
    return { node: beforeText, offset: beforeText.textContent?.length ?? 0 }
  }

  const onlyChild = offset === 0 && element === editor && element.childNodes.length === 1
    ? element.childNodes[0]
    : null
  const onlyText = onlyChild ? getLastTextNode(onlyChild) : null
  if (onlyText) {
    return { node: onlyText, offset: onlyText.textContent?.length ?? 0 }
  }

  return null
}

function getMentionContext(
  editor: HTMLElement,
): { query: string; range: Range; trigger: '@' | '#' } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null

  const { startContainer: node, startOffset: offset } = sel.getRangeAt(0)
  const textSelection = getSelectionTextNode(editor, node, offset)
  if (!textSelection) return null

  const text = (textSelection.node.textContent ?? '').slice(0, textSelection.offset)
  const match = text.match(/(^|[\s\u00A0([{])([@#])([^\s\u00A0]*)$/)
  if (!match) return null

  const trigger = match[2] === '#' ? '#' : '@'
  const query = match[3] ?? ''
  const atPos = textSelection.offset - query.length - 1

  const range = document.createRange()
  range.setStart(textSelection.node, atPos)
  range.setEnd(textSelection.node, textSelection.offset)
  return { query, range, trigger }
}

/**
 * The picture beside a mention suggestion. A user and an agent both carry a
 * real id here, so both resolve their actual portrait; only a channel is a
 * type rather than an identity and keeps its `#`.
 */
const MentionEntityAvatar = ({ entity }: { entity: MentionEntity }) => {
  const { token } = useAuthSession()

  if (entity.type === 'channel') {
    return (
      <IdentityTile
        background="var(--overlay)"
        color="var(--tx2)"
        fallback={{ kind: 'glyph', glyph: '#' }}
        imageUrl={null}
        label={entity.name}
        size={24}
      />
    )
  }
  if (entity.type === 'agent') {
    return (
      <AgentAvatar
        agent={{ id: entity.id, name: entity.name, role: '' }}
        agentId={entity.id}
        size={24}
        token={token}
      />
    )
  }
  return <UserAvatar displayName={entity.name} size={24} token={token} userId={entity.id} />
}

function matchesEntityQuery(entity: MentionEntity, query: string): boolean {
  return `${entity.name} ${entity.insertName ?? ''} ${entity.detail ?? ''}`
    .toLowerCase()
    .includes(query.toLowerCase())
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const MentionInput = forwardRef<MentionInputHandle, Props>(
  (
    { entities, maxLength, onChange, onOversizePaste, onSubmit, placeholder },
    ref,
  ) => {
    const editorRef = useRef<HTMLDivElement>(null)
    const popupRef = useRef<HTMLDivElement>(null)
    const composingRef = useRef(false)
    const [mentionContext, setMentionContext] = useState<{
      query: string
      trigger: '@' | '#'
    } | null>(null)
    const [selectedIdx, setSelectedIdx] = useState(0)
    const [hasContent, setHasContent] = useState(false)

    const filtered = useMemo(
      () =>
        mentionContext !== null
          ? entities.filter((e) =>
              e.trigger === mentionContext.trigger &&
              matchesEntityQuery(e, mentionContext.query),
            )
          : [],
      [entities, mentionContext],
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

    const showPopup = mentionContext !== null && filtered.length > 0

    const sync = useCallback(() => {
      const el = editorRef.current
      if (!el) return
      const text = extractEditorText(el)
      if (!composingRef.current) decorateMarkdownEditor(el, text)
      setHasContent(text.trim().length > 0)
      onChange?.(text)
    }, [onChange])

    const checkMention = useCallback(() => {
      const el = editorRef.current
      if (!el) return
      const ctx = getMentionContext(el)
      if (ctx) {
        setMentionContext({ query: ctx.query, trigger: ctx.trigger })
        setSelectedIdx(0)
      } else {
        setMentionContext(null)
      }
    }, [])

    const onEdit = useCallback(
      (text: string) => {
        setHasContent(text.trim().length > 0)
        onChange?.(text)
        checkMention()
      },
      [checkMention, onChange],
    )

    useConcealedFenceInput(editorRef, onEdit)

    // Everything the component inserts on the author's behalf — toolbar
    // triggers, pastes, suggestions — goes through the same splice as typing,
    // so it lands where the caret is rather than wherever the browser would
    // put a raw execCommand.
    const applyInsertion = useCallback(
      (insertion: string) => {
        const el = editorRef.current
        if (!el) return
        onEdit(insertMarkdownEditorText(el, insertion))
      },
      [onEdit],
    )

    const insertTrigger = useCallback(
      (trigger: '@' | '#') => {
        editorRef.current?.focus()
        applyInsertion(trigger)
      },
      [applyInsertion],
    )

    const insertMention = useCallback(
      (entity: MentionEntity) => {
        const editor = editorRef.current
        if (!editor) return
        const ctx = getMentionContext(editor)
        if (!ctx) {
          setMentionContext(null)
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
        if (entity.principalUserId) {
          span.dataset.mentionPrincipalUserId = entity.principalUserId
        }
        span.className = 'mention-tag'
        span.textContent = `${entity.trigger}${entity.insertName ?? entity.name}`

        const range = sel.getRangeAt(0)
        range.insertNode(span)

        const space = document.createTextNode('\u00A0')
        span.after(space)

        const cursor = document.createRange()
        cursor.setStartAfter(space)
        cursor.collapse(true)
        sel.removeAllRanges()
        sel.addRange(cursor)

        setMentionContext(null)
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
        setMentionContext(null)
        onChange?.('')
      },
      focus() {
        editorRef.current?.focus()
      },
      getText() {
        return editorRef.current ? extractEditorText(editorRef.current) : ''
      },
      getAgentMentions() {
        return readPersonalAssistantMentions(editorRef.current)
      },
      insertAtSign() {
        insertTrigger('@')
      },
      insertHashSign() {
        insertTrigger('#')
      },
      setText(text: string) {
        const el = editorRef.current
        if (!el) return
        decorateMarkdownEditor(el, text)
        setHasContent(text.trim().length > 0)
        onChange?.(text)
      },
      insertText(text: string) {
        const el = editorRef.current
        if (!el) return
        el.focus()
        // Place the cursor at the end so the insertion lands predictably
        // instead of wherever the last selection happened to be.
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        applyInsertion(text)
      },
    }))

    return (
      <div className="relative" style={{ isolation: 'isolate' }}>
        {showPopup ? (
          <div
            ref={popupRef}
            className={[
              'absolute bottom-full left-0 z-50 mb-1 max-h-[220px] w-[320px] max-w-[calc(100vw-40px)]',
              'overflow-y-auto rounded-lg border border-[color:var(--sep)]',
              'bg-[color:var(--main)] shadow-xl',
            ].join(' ')}
          >
            {filtered.map((entity, i) => (
              <button
                key={`${entity.type}:${entity.id}:${entity.principalUserId ?? ''}`}
                className={[
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                  i === selectedIdx
                    ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
                    : 'text-[color:var(--tx)] hover:bg-[color:var(--overlay-weak)]',
                ].join(' ')}
                onMouseDown={(e) => {
                  e.preventDefault()
                  insertMentionRef.current(entity)
                }}
                onMouseEnter={() => setSelectedIdx(i)}
                type="button"
              >
                <MentionEntityAvatar entity={entity} />
                <span className="min-w-0 flex flex-col">
                  <span className="truncate">{entity.name}</span>
                  {entity.detail ? (
                    <span className="truncate text-xs opacity-60">{entity.detail}</span>
                  ) : null}
                </span>
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
            // Height and padding live in styles.css: the composer collapses
            // this editor to a single centred line until it is focused, and
            // only a stylesheet can transition between the two.
            'mention-editor w-full bg-transparent text-sm text-[color:var(--tx)] outline-none',
            !hasContent ? 'is-empty' : '',
          ].join(' ')}
          contentEditable
          data-placeholder={placeholder}
          enterKeyHint="send"
          onCompositionEnd={() => {
            composingRef.current = false
            sync()
            checkMention()
          }}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onBlur={() => {
            // Delay so mouseDown on popup fires first
            setTimeout(() => setMentionContext(null), 150)
          }}
          onInput={() => {
            sync()
            checkMention()
          }}
          onKeyDown={(e) => {
            const f = filteredRef.current
            const idx = selectedIdxRef.current

            if (mentionContext !== null && f.length > 0) {
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
                setMentionContext(null)
                return
              }
            }

            if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault()
              applyInsertion('\n')
              return
            }

            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              const editor = editorRef.current
              if (!editor) return
              const text = extractEditorText(editor).trim()
              if (!text) return
              const agentMentions = readPersonalAssistantMentions(editor)
              // Clear synchronously BEFORE notifying the caller so a second
              // Enter keystroke can't re-read the same text.
              clearChildren(editor)
              setHasContent(false)
              setMentionContext(null)
              onChange?.('')
              onSubmit(text, agentMentions)
            }
          }}
          onPaste={(e) => {
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            if (maxLength && onOversizePaste) {
              const currentLength = editorRef.current
                ? extractEditorText(editorRef.current).length
                : 0
              if (currentLength + text.length > maxLength) {
                onOversizePaste(text)
                return
              }
            }
            applyInsertion(text)
          }}
          role="textbox"
          suppressContentEditableWarning
        />
      </div>
    )
  },
)

MentionInput.displayName = 'MentionInput'
