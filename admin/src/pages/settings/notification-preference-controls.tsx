type NotificationToggleProps = {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}

type PushPreferenceCardProps = {
  disabled: boolean
  pushBudgetAlerts: boolean
  pushEnabled: boolean
  pushMentions: boolean
  pushMessages: boolean
  setPushBudgetAlerts: (next: boolean) => void
  setPushEnabled: (next: boolean) => void
  setPushMentions: (next: boolean) => void
  setPushMessages: (next: boolean) => void
}

export const NotificationToggle = ({
  checked,
  disabled = false,
  label,
  onChange,
}: NotificationToggleProps) => (
  <button
    aria-checked={checked}
    aria-label={label}
    className={[
      'inline-flex h-7 w-12 items-center rounded-full border p-0.5 transition-colors',
      checked
        ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-white'
        : 'border-[color:var(--sep)] bg-[color:var(--scrim)] text-[color:var(--tx3)]',
      disabled ? 'cursor-not-allowed opacity-60' : '',
    ].join(' ')}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    role="switch"
    type="button"
  >
    <span
      className={[
        'h-6 w-6 rounded-full bg-white shadow-sm transition-transform',
        checked ? 'translate-x-5' : 'translate-x-0',
      ].join(' ')}
    />
  </button>
)

export const PushPreferenceCard = ({
  disabled,
  pushBudgetAlerts,
  pushEnabled,
  pushMentions,
  pushMessages,
  setPushBudgetAlerts,
  setPushEnabled,
  setPushMentions,
  setPushMessages,
}: PushPreferenceCardProps) => (
  <section className="admin-card p-4">
    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
      Push
    </div>
    <div className="mt-4 flex items-center justify-between gap-4">
      <div>
        <div className="font-semibold text-[color:var(--tx)]">Push enabled</div>
        <div className="mt-1 text-sm text-[color:var(--tx2)]">
          {pushEnabled ? 'Enabled' : 'Disabled'}
        </div>
      </div>
      <NotificationToggle
        checked={pushEnabled}
        disabled={disabled}
        label="Toggle push notifications"
        onChange={setPushEnabled}
      />
    </div>
    <div className="mt-5 border-t border-[color:var(--sep)] pt-4">
      <div className="font-semibold text-[color:var(--tx)]">Notify me about</div>
      <div className="mt-1 text-sm text-[color:var(--tx2)]">
        Every type starts enabled. Nessie skips an external push when an active app is already
        showing that exact channel or page.
      </div>
      <div className="mt-4 grid gap-3">
        {[
          {
            checked: pushMessages,
            description: 'New posts in channels you belong to.',
            label: 'Channel messages',
            onChange: setPushMessages,
          },
          {
            checked: pushMentions,
            description: 'Messages that explicitly @mention you.',
            label: 'Mentions',
            onChange: setPushMentions,
          },
          {
            checked: pushBudgetAlerts,
            description: 'Operational budget warnings and blocks for organisation owners.',
            label: 'Budget alerts',
            onChange: setPushBudgetAlerts,
          },
        ].map((preference) => (
          <div className="flex items-center justify-between gap-4" key={preference.label}>
            <div>
              <div className="font-medium text-[color:var(--tx)]">{preference.label}</div>
              <div className="mt-0.5 text-sm text-[color:var(--tx2)]">
                {preference.description}
              </div>
            </div>
            <NotificationToggle
              checked={preference.checked}
              disabled={!pushEnabled || disabled}
              label={`Toggle ${preference.label.toLowerCase()} notifications`}
              onChange={preference.onChange}
            />
          </div>
        ))}
      </div>
    </div>
  </section>
)
