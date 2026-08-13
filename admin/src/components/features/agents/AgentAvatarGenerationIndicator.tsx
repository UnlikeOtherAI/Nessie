type AgentAvatarGenerationIndicatorProps = {
  className?: string
  iconOnly?: boolean
}

export const AgentAvatarGenerationIndicator = ({
  className = '',
  iconOnly = false,
}: AgentAvatarGenerationIndicatorProps) => (
  <span
    aria-label={iconOnly ? 'Creating an original headshot' : undefined}
    aria-live="polite"
    className={[
      'flex items-center gap-2 text-sm text-[color:var(--tx2)]',
      className,
    ].join(' ')}
    role="status"
  >
    <svg
      aria-hidden="true"
      className="h-4 w-4 animate-spin text-[color:var(--accent)]"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeLinecap="round" strokeWidth="3" />
    </svg>
    {iconOnly ? null : <span>Creating an original headshot…</span>}
  </span>
)
