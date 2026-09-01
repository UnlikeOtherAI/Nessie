type SwitchProps = {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}

export const Switch = ({ checked, disabled = false, label, onChange }: SwitchProps) => (
  <button
    aria-checked={checked}
    aria-label={label}
    className={[
      'inline-flex h-6 w-11 items-center rounded-full border transition-colors',
      checked
        ? 'border-[color:var(--accent)] bg-[color:var(--accent)]'
        : 'border-[color:var(--border-strong)] bg-[color:var(--overlay-weak)]',
      disabled ? 'cursor-not-allowed opacity-50' : '',
    ].join(' ')}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    role="switch"
    type="button"
  >
    <span
      className={[
        'h-4 w-4 rounded-full bg-[color:var(--on-accent)] transition-transform',
        checked ? 'translate-x-5' : 'translate-x-1',
      ].join(' ')}
    />
  </button>
)
