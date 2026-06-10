import type { PushCredentialResult, PushTestResult } from '@nessie/schemas'

export const PushStatusRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-3">
    <span className="text-[color:var(--tx3)]">{label}</span>
    <span className="break-all text-right font-mono text-xs text-[color:var(--tx)]">{value}</span>
  </div>
)

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
