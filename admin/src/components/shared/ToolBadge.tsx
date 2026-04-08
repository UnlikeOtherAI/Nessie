type ToolBadgeProps = {
  label: string
}

export const ToolBadge = ({ label }: ToolBadgeProps) => (
    <span
      className={[
        'inline-flex rounded-full bg-[color:var(--accent-soft)] px-3 py-1',
        'text-xs font-semibold uppercase tracking-[0.18em]',
        'text-[color:var(--accent)]',
      ].join(' ')}
    >
      {label}
  </span>
)
