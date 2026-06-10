type UnreadBadgeProps = {
  value: number
}

export const UnreadBadge = ({ value }: UnreadBadgeProps) =>
  value > 0 ? (
    <span
      className={[
        'inline-flex min-w-6 items-center justify-center rounded-full',
        'bg-[color:var(--accent)] px-2 py-1 text-[10px]',
        'font-semibold text-[color:var(--on-accent)]',
      ].join(' ')}
    >
      {value}
    </span>
  ) : null
