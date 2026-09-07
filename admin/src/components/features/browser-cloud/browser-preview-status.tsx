import { formatCountdown } from './session-countdown'

type BrowserPreviewStatusProps = {
  countdown: { expired: boolean; secondsLeft: number } | null
  disclosure: string
  onContinue: () => void
  pending: boolean
  status: string
  variant: 'fullscreen' | 'panel'
}

/** Status belongs with the moving picture in every layout, including a drawer. */
export const BrowserPreviewStatus = ({
  countdown,
  disclosure,
  onContinue,
  pending,
  status,
  variant,
}: BrowserPreviewStatusProps) => (
  <div
    aria-live="polite"
    className={`pointer-events-none absolute inset-x-3 flex flex-col items-center gap-2 ${
      variant === 'panel' ? 'top-3' : 'bottom-3'
    }`}
  >
    <span className="max-w-full rounded-md bg-[color:var(--main)] px-3 py-2 text-center text-xs text-[color:var(--tx)] shadow-sm">
      {status}{variant === 'panel' ? disclosure : ''}
    </span>
    {variant === 'panel' && countdown ? (
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-md bg-[color:var(--main)] px-2 py-1.5 text-xs text-[color:var(--tx)] shadow-sm">
        <span className="min-w-0 text-center">
          {countdown.expired ? 'Browser is closing.' : `Closes in ${formatCountdown(countdown.secondsLeft)}.`}
        </span>
        <button
          className="admin-button admin-button-primary admin-button-compact shrink-0"
          disabled={pending}
          onClick={onContinue}
          type="button"
        >
          {pending ? 'Keeping…' : 'Continue'}
        </button>
      </div>
    ) : null}
  </div>
)
