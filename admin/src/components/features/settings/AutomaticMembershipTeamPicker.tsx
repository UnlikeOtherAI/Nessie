/**
 * The organisation surface's team checkboxes.
 *
 * A `fieldset`/`legend` because it is one question with several answers, and
 * `Checkbox` rather than `Switch` for the same reason — the admin's rule is
 * that a switch turns one thing on and a checkbox picks several out of many.
 * The bordered scroll box is the pattern `MemberDetailsDialog` already uses for
 * workspace access, so the two read as the same control.
 */

import { useState } from 'react'
import type {
  AutomaticMembershipRuleRecord,
  AutomaticMembershipTeamOption,
} from '@nessie/schemas'

import { Checkbox } from '../../primitives/Checkbox'
import { EmptyState } from '../../shared/EmptyState'
import { FormActions } from '../../shared/FormActions'

type Props = {
  domainId: string
  options: AutomaticMembershipTeamOption[]
  rules: AutomaticMembershipRuleRecord[]
  disabled: boolean
  pending: boolean
  onSave: (teamIds: string[]) => void
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join()

export const AutomaticMembershipTeamPicker = ({
  disabled,
  domainId,
  onSave,
  options,
  pending,
  rules,
}: Props) => {
  const selectedFromServer = rules.map((rule) => rule.teamId)
  // Re-sync when the server's answer changes — after a save, or after another
  // administrator edits the same domain. Adjusting state during render against
  // a remembered key is React's documented shape for this; an effect would run
  // a frame late and needs a dependency the linter cannot check.
  const serverKey = `${domainId}:${[...selectedFromServer].sort().join(',')}`
  const [selection, setSelection] = useState({ ids: selectedFromServer, key: serverKey })
  if (selection.key !== serverKey) {
    setSelection({ ids: selectedFromServer, key: serverKey })
  }
  const selected = selection.ids
  const setSelected = (next: (current: string[]) => string[]) => {
    setSelection((current) => ({ ids: next(current.ids), key: current.key }))
  }

  const dirty = !sameIds(selected, selectedFromServer)

  const toggle = (teamId: string, checked: boolean) => {
    setSelected((current) =>
      checked ? [...current, teamId] : current.filter((id) => id !== teamId))
  }

  if (options.length === 0) {
    return (
      <EmptyState title="No teams yet">
        Create a team before setting up automatic access.
      </EmptyState>
    )
  }

  return (
    <div className="grid gap-3">
      <fieldset className="grid gap-2" disabled={disabled}>
        <legend className="text-xs uppercase tracking-wide text-[color:var(--tx3)]">
          Teams to add people to
        </legend>
        {/* No second frame: the domain card is already a bordered box, and
            docs/standards/design-system.md forbids nesting one inside another.
            Depth here is spacing and a divider, not another border. */}
        <div className="max-h-64 overflow-y-auto border-t border-[color:var(--border)] pt-3">
          <div className="grid gap-2">
            {options.map((team) => (
              <Checkbox
                checked={selected.includes(team.id)}
                disabled={disabled}
                key={team.id}
                label={team.name}
                onChange={(checked) => toggle(team.id, checked)}
              />
            ))}
          </div>
        </div>
      </fieldset>
      {dirty ? (
        <FormActions>
          <button
            className="admin-button admin-button-primary admin-button-sm"
            disabled={pending}
            onClick={() => onSave(selected)}
            type="button"
          >
            {pending ? 'Saving…' : 'Save teams'}
          </button>
          <button
            className="admin-button admin-button-secondary admin-button-sm"
            disabled={pending}
            onClick={() => setSelection({ ids: selectedFromServer, key: serverKey })}
            type="button"
          >
            Discard
          </button>
        </FormActions>
      ) : null}
    </div>
  )
}
