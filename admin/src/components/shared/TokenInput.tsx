import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { faCheck, faPlus } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Popover } from '../overlays/Popover'
import {
  buildTokenRows,
  decideTokenKey,
  type TokenInputOption,
  type TokenInputRow,
  type TokenInputToken,
  type TokenKeyAction,
} from '../primitives/token-input-keys'

export type { TokenInputOption, TokenInputToken }

export type TokenInputProps = {
  ariaLabel: string
  /** The create row's text. Defaults to `Create “x”`. */
  createLabel?: (text: string) => string
  disabled?: boolean
  /** A line under the list, outside it — *Manage labels…*. */
  footer?: ReactNode
  /** The input's id, for a `<label htmlFor>`. */
  id?: string
  onAdd: (id: string) => void
  /**
   * Omit to hide the create row. Resolves with the new (or adopted) option's
   * id, which the field then adds; a rejection is shown in the list.
   */
  onCreate?: (text: string) => Promise<{ id: string }>
  onRemove: (id: string) => void
  options: TokenInputOption[]
  placeholder?: string
  /** A row's content after the check column. Defaults to the label. */
  renderOption?: (option: TokenInputOption, active: boolean, selected: boolean) => ReactNode
  /**
   * A chosen token. `remove` is undefined when the token may not be taken off
   * (field disabled, or `removable: false`); `highlighted` is the
   * Backspace-once state that a second Backspace removes.
   */
  renderToken?: (token: TokenInputToken, remove: (() => void) | undefined, highlighted: boolean) => ReactNode
  tokens: TokenInputToken[]
}

const defaultCreateLabel = (text: string) => `Create “${text}”`

const rowKey = (row: TokenInputRow) =>
  row.kind === 'create' ? `create:${row.text}` : `option:${row.option.id}`

/**
 * Pills inside a growing field, with a type-to-filter list of every option.
 *
 * The field is the anchor and the combobox: the text input sits after the last
 * pill and takes the remaining width, so the box grows a line at a time as
 * pills wrap. The list opens on focus and on typing, chosen options first and
 * checked; a *Create* row appears when the text names nothing that exists.
 * Every key is decided by `token-input-keys.ts`, which is where the behaviour
 * is specified and tested — this component only applies the answer.
 */
export const TokenInput = ({
  ariaLabel,
  createLabel = defaultCreateLabel,
  disabled = false,
  footer,
  id,
  onAdd,
  onCreate,
  onRemove,
  options,
  placeholder,
  renderOption,
  renderToken,
  tokens,
}: TokenInputProps) => {
  const generatedId = useId()
  const inputId = id ?? `${generatedId}-input`
  const listboxId = `${generatedId}-listbox`
  const optionId = (index: number) => `${generatedId}-option-${index}`

  const fieldRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [highlightedTokenId, setHighlightedTokenId] = useState<string | null>(null)
  const [creating, setCreating] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  const canCreate = Boolean(onCreate) && !disabled
  const selectedIds = useMemo(() => tokens.map((token) => token.id), [tokens])
  const rows = useMemo(
    () => buildTokenRows({ canCreate, options, query, selectedIds }),
    [canCreate, options, query, selectedIds],
  )
  const activeRow = activeIndex === null ? undefined : rows[activeIndex]

  // A list that shrank under the active row (a filter, a refetch) keeps a
  // valid index or none.
  useEffect(() => {
    if (activeIndex !== null && activeIndex >= rows.length) {
      setActiveIndex(rows.length === 0 ? null : rows.length - 1)
    }
  }, [activeIndex, rows.length])

  useEffect(() => {
    if (!open || activeIndex === null) return
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  const close = () => {
    setOpen(false)
    setActiveIndex(null)
  }

  const resetQuery = () => {
    setQuery('')
    setActiveIndex(null)
  }

  const create = (text: string) => {
    if (!onCreate || creating !== null) return
    setCreating(text)
    setCreateError(null)
    onCreate(text)
      .then(({ id: createdId }) => {
        if (!selectedIds.includes(createdId)) onAdd(createdId)
        resetQuery()
      })
      .catch((error: unknown) => {
        setCreateError(error instanceof Error && error.message ? error.message : 'Could not create it.')
      })
      .finally(() => {
        setCreating(null)
        inputRef.current?.focus()
      })
  }

  const apply = (action: TokenKeyAction) => {
    switch (action.type) {
      case 'none':
        return
      case 'open':
        setOpen(true)
        setActiveIndex(action.activeIndex)
        return
      case 'move':
        setActiveIndex(action.activeIndex)
        return
      case 'toggle':
        if (selectedIds.includes(action.id)) onRemove(action.id)
        else onAdd(action.id)
        resetQuery()
        return
      case 'add':
        if (!selectedIds.includes(action.id)) onAdd(action.id)
        resetQuery()
        return
      case 'create':
        create(action.text)
        return
      case 'highlight-token':
        setHighlightedTokenId(action.id)
        return
      case 'remove-token':
        onRemove(action.id)
        setHighlightedTokenId(null)
        return
      case 'close':
        close()
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (disabled) return
    const decision = decideTokenKey(event.key, {
      activeIndex,
      canCreate,
      highlightedTokenId,
      open,
      options,
      query,
      rows,
      tokens,
    })
    if (decision.preventDefault) event.preventDefault()
    if (decision.stopPropagation) event.stopPropagation()
    // Any key but the second Backspace lets go of a highlighted pill.
    if (decision.action.type !== 'highlight-token' && decision.action.type !== 'remove-token') {
      setHighlightedTokenId(null)
    }
    apply(decision.action)
  }

  const pickRow = (row: TokenInputRow) => {
    if (row.kind === 'create') {
      create(row.text)
      return
    }
    if (row.option.disabled) return
    apply({ type: 'toggle', id: row.option.id })
  }

  return (
    <div className="admin-token-input-wrap">
      <div
        className="admin-input admin-token-input"
        data-disabled={disabled ? 'true' : undefined}
        data-open={open ? 'true' : undefined}
        // A press on the box (not on a pill's ×, not on the input itself)
        // puts the caret in the input, the way a text field behaves.
        onMouseDown={(event) => {
          if (disabled || event.target === inputRef.current) return
          event.preventDefault()
          inputRef.current?.focus()
          setOpen(true)
        }}
        ref={fieldRef}
      >
        {tokens.map((token) => {
          const removable = !disabled && token.removable !== false
          const remove = removable
            ? () => {
                onRemove(token.id)
                setHighlightedTokenId(null)
              }
            : undefined
          const highlighted = token.id === highlightedTokenId
          return (
            <span
              className="admin-token-input-token"
              data-highlighted={highlighted ? 'true' : undefined}
              data-token-id={token.id}
              key={token.id}
            >
              {renderToken
                ? renderToken(token, remove, highlighted)
                : <span className="admin-token-input-chip">{token.label}</span>}
            </span>
          )
        })}
        <input
          aria-activedescendant={open && activeIndex !== null && activeRow ? optionId(activeIndex) : undefined}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          autoComplete="off"
          className="admin-token-input-text"
          disabled={disabled}
          id={inputId}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(null)
            setHighlightedTokenId(null)
            setCreateError(null)
            setOpen(true)
          }}
          onFocus={() => {
            if (!disabled) setOpen(true)
          }}
          onKeyDown={onKeyDown}
          placeholder={tokens.length === 0 ? placeholder : undefined}
          ref={inputRef}
          role="combobox"
          type="text"
          value={query}
        />
      </div>

      <Popover
        anchorRef={fieldRef}
        className="admin-token-input-popover"
        label={ariaLabel}
        matchAnchorWidth
        onClose={close}
        open={open && !disabled}
        placement="bottom-start"
        role="dialog"
      >
        <div
          aria-label={ariaLabel}
          aria-multiselectable="true"
          className="admin-token-input-list"
          id={listboxId}
          ref={listRef}
          role="listbox"
        >
          {rows.length === 0 ? (
            <div className="admin-token-input-empty" role="presentation">
              {query.trim() ? 'No matches' : 'Nothing to choose yet'}
            </div>
          ) : null}
          {rows.map((row, index) => {
            const active = index === activeIndex
            if (row.kind === 'create') {
              const pending = creating === row.text
              return (
                <div
                  aria-disabled={pending || undefined}
                  aria-selected={false}
                  className="admin-token-input-option"
                  data-active={active ? 'true' : undefined}
                  data-create="true"
                  id={optionId(index)}
                  key={rowKey(row)}
                  onClick={() => pickRow(row)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                >
                  <span aria-hidden="true" className="admin-token-input-check">
                    <FontAwesomeIcon icon={faPlus} />
                  </span>
                  <span className="min-w-0 truncate">
                    {pending ? `Creating “${row.text}”…` : createLabel(row.text)}
                  </span>
                </div>
              )
            }
            const { option, selected } = row
            return (
              <div
                aria-disabled={option.disabled || undefined}
                aria-selected={selected}
                className="admin-token-input-option"
                data-active={active ? 'true' : undefined}
                id={optionId(index)}
                key={rowKey(row)}
                onClick={() => pickRow(row)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                title={option.title}
              >
                <span aria-hidden="true" className="admin-token-input-check">
                  {selected ? <FontAwesomeIcon icon={faCheck} /> : null}
                </span>
                <span className="flex min-w-0 flex-1 items-center">
                  {renderOption ? renderOption(option, active, selected) : option.label}
                </span>
              </div>
            )
          })}
        </div>
        {createError ? (
          <div className="admin-token-input-error" role="alert">{createError}</div>
        ) : null}
        {footer ? <div className="admin-token-input-footer">{footer}</div> : null}
      </Popover>
    </div>
  )
}
