import { useState } from 'react'

import { Pill } from '../../primitives/Pill'
import { Dialog } from '../../shared/Dialog'
import { Row } from '../../shared/RowList'

/**
 * The prototype's "Nessie Team seats" row and "Manage seats" modal, built in
 * full for visual parity — but Nessie has no seat model in the real billing
 * protocol/API (and the product's own marketing copy says agents don't take
 * a seat), so there is nothing to wire this to. It is a deliberate,
 * clearly-marked no-op: the counter only changes local component state, and
 * Save is disabled rather than pretending to persist anything. See the
 * page-bottom Leftovers note.
 */
export const UoaBillingSeatsRow = () => {
  const [open, setOpen] = useState(false)
  const [draftSeats, setDraftSeats] = useState(1)

  return (
    <>
      <Row
        subtitle="Nessie has no per-seat charge today — this control has nothing to connect to yet."
        title="Nessie Team seats"
        trailing={(
          <div className="flex items-center gap-2">
            <Pill tone="warning">Needs backend</Pill>
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              onClick={() => setOpen(true)}
              type="button"
            >
              Manage seats
            </button>
          </div>
        )}
      />
      <Dialog
        description="Preview only — no seat model exists in Nessie's billing yet, so nothing here is saved."
        onClose={() => setOpen(false)}
        open={open}
        title="Nessie Team seats"
      >
        <div className="flex items-center justify-between gap-4 rounded-xl bg-[color:var(--overlay-weak)] p-4">
          <div>
            <div className="text-sm font-semibold text-[color:var(--tx)]">Seats</div>
            <div className="mt-0.5 text-xs text-[color:var(--tx2)]">
              Not billed — preview control only
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={draftSeats <= 1}
              onClick={() => setDraftSeats((value) => Math.max(1, value - 1))}
              type="button"
            >
              −
            </button>
            <div className="w-10 text-center text-lg font-semibold text-[color:var(--tx)]">
              {draftSeats}
            </div>
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={draftSeats >= 50}
              onClick={() => setDraftSeats((value) => Math.min(50, value + 1))}
              type="button"
            >
              +
            </button>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            className="admin-button admin-button-secondary"
            onClick={() => setOpen(false)}
            type="button"
          >
            Close
          </button>
          <button
            className="admin-button admin-button-primary disabled:cursor-not-allowed disabled:opacity-50"
            disabled
            title="Not connected to billing yet"
            type="button"
          >
            Save
          </button>
        </div>
      </Dialog>
    </>
  )
}
