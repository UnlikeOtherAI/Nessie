type ToolTransportPillProps = {
  safe: boolean
}

export const ToolTransportPill = ({ safe }: ToolTransportPillProps) => (
    <span
      className={[
        'inline-flex rounded-full border border-[color:var(--line)]',
        'bg-white/70 px-3 py-1 text-xs uppercase',
        'tracking-[0.18em]',
        'text-[color:var(--muted)]',
      ].join(' ')}
    >
      {safe ? 'local' : 'remote'}
  </span>
)
