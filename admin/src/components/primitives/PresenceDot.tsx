type PresenceDotProps = {
  active?: boolean
}

export const PresenceDot = ({ active = false }: PresenceDotProps) => (
  <span
    aria-hidden="true"
    className={`inline-flex h-2.5 w-2.5 rounded-full ${
      active ? 'bg-emerald-500' : 'bg-[color:var(--muted)]/35'
    }`}
  />
)
