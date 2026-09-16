import { faRotate, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { columnIndexToLabel, formatA1Range } from '@nessie/schemas'
import type {
  SpreadsheetFilterCriterion,
  SpreadsheetFilterModel,
} from '../../../../facades/knowledge/spreadsheet-hooks'

/**
 * What is currently hidden, and why, said in words under the action bar.
 *
 * Sheets leaves this implicit — a funnel icon on a header and nothing else —
 * and people routinely miss that a sheet is filtered at all. The chips bar is
 * the deliberate departure: every active criterion is named, each can be
 * cleared on its own, and `Re-apply` is here because re-application is explicit
 * (editing a value does not re-filter until asked).
 */

type ConditionOp = Extract<SpreadsheetFilterCriterion, { kind: 'condition' }>['op']

const OP_LABELS: Record<ConditionOp, string> = {
  between: 'between',
  contains: 'contains',
  empty: 'is empty',
  endsWith: 'ends with',
  eq: '=',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  ne: '≠',
  notContains: 'does not contain',
  notEmpty: 'is not empty',
  startsWith: 'starts with',
}

export const criterionLabel = (
  column: number,
  criterion: SpreadsheetFilterCriterion,
  headerLabel?: string,
): string => {
  const name = headerLabel?.trim() || columnIndexToLabel(column)
  if (criterion.kind === 'values') {
    const shown = criterion.values.slice(0, 2).join(', ')
    const rest = criterion.values.length - 2
    const blanks = criterion.blanks ? ' + blanks' : ''
    if (criterion.values.length === 0) return `${name}: blanks only`
    return `${name}: ${shown}${rest > 0 ? ` +${rest} more` : ''}${blanks}`
  }
  const op = OP_LABELS[criterion.op]
  if (criterion.op === 'empty' || criterion.op === 'notEmpty') return `${name} ${op}`
  if (criterion.op === 'between') return `${name} ${op} ${criterion.value} and ${criterion.value2 ?? ''}`
  return `${name} ${op} ${criterion.value}`
}

type FilterChipsBarProps = {
  headerLabels?: Record<number, string>
  model: SpreadsheetFilterModel
  onClearAll: () => void
  onClearColumn: (column: number) => void
  onReapply: () => void
  pending?: boolean
}

export const FilterChipsBar = ({
  headerLabels,
  model,
  onClearAll,
  onClearColumn,
  onReapply,
  pending = false,
}: FilterChipsBarProps) => {
  const entries = Object.entries(model.columns).map(([column, criterion]) => ({
    column: Number(column),
    criterion,
  }))
  if (entries.length === 0) return null

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-[color:var(--sep)] bg-[color:var(--sb)] px-3 py-1.5"
      data-testid="spreadsheet-filter-chips"
    >
      <span className="text-xs text-[color:var(--tx3)]">
        Filtered {formatA1Range(model.range)}:
      </span>
      {entries.map(({ column, criterion }) => (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-[color:var(--sep)] bg-[color:var(--panel)] px-2 py-0.5 text-xs text-[color:var(--tx2)]"
          data-testid={`spreadsheet-filter-chip-${column}`}
          key={column}
        >
          {criterionLabel(column, criterion, headerLabels?.[column])}
          <button
            aria-label={`Clear the filter on column ${columnIndexToLabel(column)}`}
            className="text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
            onClick={() => onClearColumn(column)}
            type="button"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </span>
      ))}
      <button
        className="admin-button admin-button-secondary admin-button-compact ml-auto gap-1.5"
        data-testid="spreadsheet-filter-reapply"
        disabled={pending}
        onClick={onReapply}
        title="Re-evaluate the criteria against the current values"
        type="button"
      >
        <FontAwesomeIcon icon={faRotate} />
        Re-apply
      </button>
      <button
        className="admin-button admin-button-secondary admin-button-compact"
        onClick={onClearAll}
        type="button"
      >
        Clear all
      </button>
    </div>
  )
}
