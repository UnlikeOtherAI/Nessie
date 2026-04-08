type ToolCategoryIconProps = {
  safe: boolean
}

export const ToolCategoryIcon = ({ safe }: ToolCategoryIconProps) => (
    <span
      className={[
        'inline-flex h-9 w-9 items-center justify-center rounded-2xl',
        'bg-[color:var(--accent-soft)] text-sm font-semibold',
        'text-[color:var(--accent)]',
      ].join(' ')}
    >
      {safe ? 'S' : 'X'}
  </span>
)
