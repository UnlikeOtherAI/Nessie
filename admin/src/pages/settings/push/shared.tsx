import type { PushCredentialResult, PushTestResult } from '@nessie/schemas'
import { Notice } from '../../../components/primitives/Notice'

export const PushStatusRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-3">
    <span className="text-[color:var(--tx3)]">{label}</span>
    <span className="break-all text-right font-mono text-xs text-[color:var(--tx)]">{value}</span>
  </div>
)

/**
 * The house success/danger banner. This used to be a knowing, bordered-free
 * fork of `Notice` kept apart on the grounds that `Notice` could not express
 * a borderless tint — `Notice`'s tone map already carries the border, so the
 * fork is retired onto it rather than kept as a second shape for the same
 * "did the save work" message every other settings page already shows this
 * way.
 */
export const PushResultBanner = ({
  result,
}: {
  result: PushCredentialResult | PushTestResult | null
}) => {
  if (!result) return null
  return (
    <Notice
      className="mt-3"
      role={result.ok ? 'status' : 'alert'}
      tone={result.ok ? 'success' : 'danger'}
    >
      {result.message}
    </Notice>
  )
}
