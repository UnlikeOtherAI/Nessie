type ToolPermissionPillProps = {
  safe: boolean
}

export const ToolPermissionPill = ({ safe }: ToolPermissionPillProps) => (
  <span
    className={[
      'inline-flex rounded-full border px-3 py-1 text-xs uppercase tracking-[0.18em]',
      safe
        ? 'border-[color:var(--accent)]/20 bg-[color:var(--accent-soft)] text-[color:var(--accent)]'
        : 'border-[color:var(--danger)]/20 bg-[color:var(--danger)]/8 text-[color:var(--danger)]',
    ].join(' ')}
  >
    {safe ? 'safe' : 'restricted'}
  </span>
)
