import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { AgentMention, AgentVisibility } from '@nessie/schemas'

import {
  decorateMarkdownEditor,
  extractEditorText,
  insertMarkdownEditorText,
  markdownEditorCaretOffset,
} from '../../lib/markdown-editor'
import { formatDictationInsertion } from '../../lib/dictation-text'
import { useConcealedFenceInput } from '../../hooks/useConcealedFenceInput'
import { readAgentMentions } from './mention-input-agents'
import { clearChildren, getMentionContext, matchesEntityQuery } from './mention-input-dom'
import { MentionSuggestionList } from './MentionSuggestionList'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type MentionEntity = {
  agentVisibility?: AgentVisibility
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

export type { AgentMention } from '@nessie/schemas'

export type MentionInputHandle = {
  clear: () => void
  focus: () => void
  getAgentMentions: () => AgentMention[]
  getText: () => string
  insertAtSign: () => void
  insertDictationText: (text: string) => void
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
  /** Enter sends an empty draft — set while staged files are the message. */
  canSubmitEmpty?: boolean
  entities: MentionEntity[]
  maxLength?: number
  onChange?: (text: string) => void
  onOversizePaste?: (paste: string) => void
  /**
   * Receives a paste that carries files and no text — a screenshot, a copied
   * image. Without it that paste inserts nothing.
   */
  onPasteFiles?: (files: File[]) => void
  onSubmit: (text: string, agentMentions: AgentMention[]) => void
  /** Holds the draft in place while a related composer action is in progress. */
  submitDisabled?: boolean
  placeholder: string
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const MentionInput = forwardRef<MentionInputHandle, Props>(
  (
    {
      canSubmitEmpty = false,
      entities,
      maxLength,
      onChange,
      onOversizePaste,
      onPasteFiles,
      onSubmit,
      submitDisabled = false,
      placeholder,
    },
    ref,
  ) => {
    const editorRef = useRef<HTMLDivElement>(null)
    const popupRef = useRef<HTMLDivElement>(null)
    const composingRef = useRef(false)
    const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const rememberedCaret = useRef<number | null>(null)
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

    // The blur-close delay (below) is a plain event-handler timer, not an
    // effect's own — this is the one thing that owns its lifetime and clears
    // it on unmount so a blur just before unmount can't fire into disposed
    // state.
    useEffect(() => {
      return () => {
        if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
      }
    }, [])

    const showPopup = mentionContext !== null && filtered.length > 0

    const sync = useCallback(() => {
      const el = editorRef.current
      if (!el) return
      const text = extractEditorText(el)
      if (!composingRef.current) decorateMarkdownEditor(el, text)
      rememberedCaret.current = markdownEditorCaretOffset(el)
      setHasContent(text.trim().length > 0)
      onChange?.(text)
    }, [onChange])

    const rememberCaret = useCallback(() => {
      const editor = editorRef.current
      if (editor) rememberedCaret.current = markdownEditorCaretOffset(editor)
    }, [])

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

        const space = document.createTextNode(' ')
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
        // `preventScroll` because this can be called as a screen mounts, and a
        // focus inside a layer parked off to the right scrolls its stack
        // container sideways (docs/navigation/overview.md §2, "the bounce").
        editorRef.current?.focus({ preventScroll: true })
      },
      getText() {
        return editorRef.current ? extractEditorText(editorRef.current) : ''
      },
      getAgentMentions() {
        return readAgentMentions(editorRef.current)
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
        // Existing programmatic inserts (for example a quoted message) retain
        // their historical append behavior. Dictation has a dedicated cursor-
        // preserving method below because the microphone takes focus.
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(false)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        applyInsertion(text)
      },
      insertDictationText(text: string) {
        const el = editorRef.current
        if (!el) return
        const cursor = markdownEditorCaretOffset(el)
          ?? rememberedCaret.current
          ?? extractEditorText(el).length
        const currentText = extractEditorText(el)
        const insertion = formatDictationInsertion(
          currentText.slice(0, cursor),
          text,
          currentText.slice(cursor),
        )
        el.focus()
        // The microphone takes focus while recording, so keep the author's
        // last contenteditable caret and restore it for the transcription.
        onEdit(insertMarkdownEditorText(el, insertion, cursor))
        rememberedCaret.current = cursor + insertion.length
      },
    }))

    return (
      <div className="relative" style={{ isolation: 'isolate' }}>
        {showPopup ? (
          <MentionSuggestionList
            filtered={filtered}
            listRef={popupRef}
            onHover={setSelectedIdx}
            onPick={(entity) => insertMentionRef.current(entity)}
            selectedIdx={selectedIdx}
          />
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
            rememberCaret()
            // Delay so mouseDown on popup fires first
            if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
            blurTimeoutRef.current = setTimeout(() => setMentionContext(null), 150)
          }}
          onInput={() => {
            sync()
            checkMention()
          }}
          onKeyUp={rememberCaret}
          onMouseUp={rememberCaret}
          onSelect={rememberCaret}
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
              if (submitDisabled) return
              const editor = editorRef.current
              if (!editor) return
              const text = extractEditorText(editor).trim()
              if (!text && !canSubmitEmpty) return
              const agentMentions = readAgentMentions(editor)
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
            // A paste that carries text is text, even when the app it came
            // from put a picture of it beside it, as Excel does with cells.
            // Files arrive on their own only when files are what was copied.
            const files = Array.from(e.clipboardData.files)
            if (onPasteFiles && files.length > 0 && !text.trim()) {
              onPasteFiles(files)
              return
            }
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
