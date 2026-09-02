import { useSetToolRegistryStatus } from '../../../facades/tool-grants/hooks'
import { FormError } from '../../shared/FormActions'

/**
 * Batch review controls above the tool list.
 *
 * One connector routinely projects dozens of tools, so approving them one at a
 * time is not a usable surface — but a single "approve everything" button
 * would hide exactly the tools that deserve a second look (a hardware
 * connector ships `command_database_reset` next to `sites_list`). The
 * compromise is selection: "Select all shown" is one click, every name stays
 * on screen, and the reviewer unchecks what they do not want before approving.
 */

type ToolReviewBarProps = {
  onClearSelection: () => void
  onSelectAllShown: () => void
  reviewableCount: number
  selectedIds: string[]
}

export const ToolReviewBar = ({
  onClearSelection,
  onSelectAllShown,
  reviewableCount,
  selectedIds,
}: ToolReviewBarProps) => {
  const setStatus = useSetToolRegistryStatus()

  if (reviewableCount === 0) return null

  const apply = (status: 'active' | 'disabled') => {
    if (selectedIds.length === 0) return
    setStatus.mutate(
      { status, toolRegistryEntryIds: selectedIds },
      { onSuccess: onClearSelection },
    )
  }

  const allShownSelected = selectedIds.length === reviewableCount

  return (
    <div className="grid gap-2 rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-[color:var(--tx3)]">
          {selectedIds.length > 0
            ? `${selectedIds.length} of ${reviewableCount} selected`
            : `${reviewableCount} connector ${reviewableCount === 1 ? 'tool' : 'tools'} you can review`}
        </span>
        <button
          className="text-xs underline text-[color:var(--tx2)]"
          onClick={allShownSelected ? onClearSelection : onSelectAllShown}
          type="button"
        >
          {allShownSelected ? 'Clear selection' : 'Select all shown'}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="admin-button-primary"
          disabled={selectedIds.length === 0 || setStatus.isPending}
          onClick={() => apply('active')}
          type="button"
        >
          {setStatus.isPending ? 'Applying…' : `Approve selected${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
        </button>
        <button
          className="admin-button"
          disabled={selectedIds.length === 0 || setStatus.isPending}
          onClick={() => apply('disabled')}
          type="button"
        >
          Disable selected
        </button>
      </div>
      <p className="text-xs text-[color:var(--tx3)]">
        Approving lets agents that are granted a tool call it. Review what each
        one does first — a connector can expose destructive actions alongside
        read-only ones.
      </p>
      <FormError>
        {setStatus.isError ? 'Could not update those tools. Try again.' : undefined}
      </FormError>
    </div>
  )
}
