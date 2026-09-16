import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { Model } from '@ironcalc/wasm'
import type { SpreadsheetSelection } from '@nessie/schemas'
import { Checkbox } from '../../../primitives/Checkbox'
import { Input, Select } from '../../../shared/FormControls'
import { Notice } from '../../../primitives/Notice'
import { Popover } from '../../../overlays/Popover'
import { findInModel, MAX_MATCHES, type FindMatch, type FindOptions } from './spreadsheet-find'
import type { SpreadsheetReplaceResult } from '../../../../facades/knowledge/spreadsheet-hooks'

/**
 * Find and replace, on Google Sheets' interaction model. Checked against
 * Sheets, 2026-09-16:
 *
 *  - Ctrl/Cmd-F opens it and the search runs as you type, stepping the
 *    selection to the first match; Enter and the chevrons walk the matches and
 *    wrap around at the ends,
 *  - the counter reads "3 of 12", and it says so even while the box has focus,
 *  - scope is workbook / this sheet / a specific range, with "Match case",
 *    "Match entire cell contents", "Search using regular expressions" and "Also
 *    search within formulas" as checkboxes,
 *  - Sheets keeps Replace and Replace all visible but inert until there is a
 *    match — a disabled button, not a hidden one, so the shape of the panel
 *    does not change as you type.
 *
 * Find is local to the mounted model. Replace posts to the route so it lands in
 * the journal, and refusals come back per cell — a formula whose replaced text
 * no longer tokenises is reported rather than half-applied.
 */

type FindReplacePopoverProps = {
  anchorRef: RefObject<HTMLElement | null>
  canWrite: boolean
  model: Model | null
  onClose: () => void
  onReplace: (input: FindOptions & { all: boolean; replacement: string }) => void
  /** Moves the grid's selection to a match. */
  onStep: (match: FindMatch) => void
  open: boolean
  replacePending?: boolean
  replaceResult?: SpreadsheetReplaceResult
  /** Bumped after every applied batch so the match list is never stale. */
  revision: number
  selection?: SpreadsheetSelection
  sheet: number
  sheets: { index: number; name: string }[]
}

export const FindReplacePopover = ({
  anchorRef,
  canWrite,
  model,
  onClose,
  onReplace,
  onStep,
  open,
  replacePending = false,
  replaceResult,
  revision,
  selection,
  sheet,
  sheets,
}: FindReplacePopoverProps) => {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [replacement, setReplacement] = useState('')
  const [scope, setScope] = useState<FindOptions['scope']>('sheet')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeCell, setWholeCell] = useState(false)
  const [regex, setRegex] = useState(false)
  const [inFormulas, setInFormulas] = useState(false)
  const [cursor, setCursor] = useState(0)

  // 200 ms, the plan's number: a 200 000-cell workbook answers in about 150 ms,
  // so a keystroke never queues behind the previous scan.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 200)
    return () => clearTimeout(timer)
  }, [query])

  const options = useMemo<FindOptions>(
    () => ({ inFormulas, matchCase, query: debounced, regex, scope, selection, wholeCell }),
    [debounced, inFormulas, matchCase, regex, scope, selection, wholeCell],
  )

  const matches = useMemo(
    () => (model && open ? findInModel(model, sheets, sheet, options) : []),
    // `revision` is not read in the body: it is the applied-batch counter, and
    // re-running the scan when it changes is the whole point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, open, options, revision, sheet, sheets],
  )

  useEffect(() => { setCursor(0) }, [debounced, scope, matchCase, wholeCell, regex, inFormulas])

  const list = matches ?? []
  const current = list[cursor]
  useEffect(() => {
    if (current) onStep(current)
    // Stepping is a side effect of the cursor moving, not of the callback's
    // identity; including `onStep` would re-select on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  const step = (delta: number): void => {
    if (list.length === 0) return
    setCursor((at) => (at + delta + list.length) % list.length)
  }

  return (
    <Popover
      anchorRef={anchorRef}
      className="w-96 overflow-auto rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3 shadow-lg"
      label="Find and replace"
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          step(event.shiftKey ? -1 : 1)
        }
      }}
      open={open}
      placement="bottom-start"
    >
      {/* `min-w-0` on the grid container, not only on the input inside it:
          a grid whose `min-width` is `auto` sizes to its own items' min-content
          and overflows the scroll panel around it, which `overflow: auto` then
          turns into a clip -- the step button and "Replace all" were simply
          outside the panel and unclickable. */}
      <div className="grid min-w-0 gap-3" data-testid="spreadsheet-find-popover">
        <div className="flex items-center gap-2">
          <Input
            aria-label="Find"
            autoFocus
            // A flex item's `min-width` defaults to its intrinsic size, and an
            // `<input>`'s intrinsic size is the UA's `size=20` -- about 177px.
            // Left alone it refuses to shrink and pushes the counter and the
            // step buttons past the panel's right edge, where `overflow: auto`
            // clips them and nothing can click them. Inline, because the class
            // did not win: `.admin-input` is an unlayered component class and
            // this is the same cascade trap as `button { font: inherit }`.
            className="flex-1"
            style={{ minWidth: 0 }}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find"
            size="compact"
            value={query}
          />
          <span
            className="w-14 shrink-0 text-right text-xs text-[color:var(--tx3)]"
            data-testid="spreadsheet-find-count"
          >
            {matches === undefined
              ? '—'
              : list.length === 0
                ? '0'
                : `${cursor + 1} of ${list.length}${list.length >= MAX_MATCHES ? '+' : ''}`}
          </span>
          <button
            aria-label="Previous match"
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={list.length === 0}
            onClick={() => step(-1)}
            type="button"
          >
            ↑
          </button>
          <button
            aria-label="Next match"
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={list.length === 0}
            onClick={() => step(1)}
            type="button"
          >
            ↓
          </button>
        </div>

        {matches === undefined ? (
          <Notice size="sm" tone="warning">That is not a valid regular expression yet.</Notice>
        ) : null}

        {canWrite ? (
          <Input
            aria-label="Replace with"
            onChange={(event) => setReplacement(event.target.value)}
            placeholder="Replace with"
            size="compact"
            value={replacement}
          />
        ) : null}

        <Select
          aria-label="Search scope"
          onChange={(event) => setScope(event.target.value as FindOptions['scope'])}
          size="compact"
          value={scope}
        >
          <option value="sheet">This sheet</option>
          <option value="workbook">All sheets</option>
          <option value="range" disabled={!selection}>Specific range</option>
        </Select>

        <div className="grid gap-1">
          <Checkbox checked={matchCase} label="Match case" onChange={setMatchCase} />
          <Checkbox checked={wholeCell} label="Match entire cell contents" onChange={setWholeCell} />
          <Checkbox checked={regex} label="Search using regular expressions" onChange={setRegex} />
          <Checkbox checked={inFormulas} label="Also search within formulas" onChange={setInFormulas} />
        </div>

        {current ? (
          <p className="truncate text-xs text-[color:var(--tx3)]">
            {current.sheetName} · {current.a1} — {current.text}
          </p>
        ) : null}

        {replaceResult ? (
          <Notice size="sm" tone={replaceResult.refusals.length > 0 ? 'warning' : 'success'}>
            Replaced {replaceResult.replaced}
            {replaceResult.refusals.length > 0
              ? `; ${replaceResult.refusals.length} refused — `
                + replaceResult.refusals
                  .slice(0, 3)
                  .map((refusal) => `${refusal.a1} (${refusal.reason})`)
                  .join(', ')
              : '.'}
          </Notice>
        ) : null}

        {canWrite ? (
          <div className="flex justify-end gap-2">
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={list.length === 0 || replacePending}
              onClick={() => onReplace({ ...options, all: false, replacement })}
              type="button"
            >
              Replace
            </button>
            <button
              className="admin-button admin-button-primary admin-button-compact"
              data-testid="spreadsheet-replace-all"
              disabled={list.length === 0 || replacePending}
              onClick={() => onReplace({ ...options, all: true, replacement })}
              type="button"
            >
              Replace all
            </button>
          </div>
        ) : null}
      </div>
    </Popover>
  )
}
