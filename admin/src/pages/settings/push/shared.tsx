import type { PushCredentialResult, PushTestResult } from '@nessie/schemas'

export const PushStatusRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-3">
    <span className="text-[color:var(--tx3)]">{label}</span>
    <span className="break-all text-right font-mono text-xs text-[color:var(--tx)]">{value}</span>
  </div>
)

/**
 * Deliberately not `Notice`. This banner ships without a border — a tinted
 * block, not an outlined one — and `Notice` is unconditionally bordered so
 * that no call site can quietly drop the house outline. Routing this one
 * through it would paint a 1px rule that has never been there and grow the box
 * 2px in each axis. Giving `Notice` a borderless mode to accommodate one
 * caller would put that seam inside the primitive instead, which is where the
 * next borderless banner would come back in.
 *
 * Whether push results *should* look like every other success/danger banner in
 * the admin is a design decision, not a refactor one; until it is taken, this
 * stays as it shipped.
 */
export const PushResultBanner = ({
  result,
}: {
  result: PushCredentialResult | PushTestResult | null
}) => {
  if (!result) return null
  return (
    <div
      className={[
        'mt-3 rounded-md p-3 text-sm',
        result.ok
          ? 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]'
          : 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
      ].join(' ')}
    >
      {result.message}
    </div>
  )
}
