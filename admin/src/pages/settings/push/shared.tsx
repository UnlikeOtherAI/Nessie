import type { PushCredentialResult, PushTestResult } from '@nessie/schemas'

export const PushStatusRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-3">
    <span className="text-[color:var(--tx3)]">{label}</span>
    <span className="break-all text-right font-mono text-xs text-white">{value}</span>
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
          ? 'bg-[color:var(--accent-soft,rgba(34,197,94,0.12))] text-[color:var(--accent)]'
          : 'bg-[rgba(239,68,68,0.12)] text-[#fca5a5]',
      ].join(' ')}
    >
      {result.message}
    </div>
  )
}
