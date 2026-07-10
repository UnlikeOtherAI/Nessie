import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import { TRIGGER_TYPE_ICONS } from './trigger-presentation'

/**
 * Radio-card picker for the trigger type in create mode. Each card explains
 * what the type does so operators do not need to know the internals.
 */

type TriggerType = AgentTriggerRecord['type']

type TriggerTypePickerProps = {
  onChange: (type: TriggerType) => void
  value: TriggerType
}

const TYPE_OPTIONS: Array<{ description: string; label: string; value: TriggerType }> = [
  {
    value: 'manual',
    label: 'Manual',
    description: 'Fires only when you press “Run now”.',
  },
  {
    value: 'scheduled',
    label: 'Schedule',
    description: 'Runs on a cron schedule or once at a set time.',
  },
  {
    value: 'interval',
    label: 'Interval',
    description: 'Repeats every N minutes.',
  },
  {
    value: 'webhook',
    label: 'Webhook',
    description: 'Fires when an external system calls an endpoint.',
  },
  {
    value: 'event',
    label: 'Event',
    description: 'Reacts to internal system events.',
  },
]

export const TriggerTypePicker = ({ onChange, value }: TriggerTypePickerProps) => (
  <div
    aria-label="Trigger type"
    className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
    role="radiogroup"
  >
    {TYPE_OPTIONS.map((option) => {
      const selected = option.value === value
      return (
        <button
          aria-checked={selected}
          className={[
            'rounded-xl border p-3 text-left transition',
            selected
              ? 'border-[color:var(--accent)] bg-[var(--accent-soft)]'
              : 'border-[color:var(--sep)] bg-[var(--scrim-weak)] hover:bg-[var(--scrim)]',
          ].join(' ')}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          type="button"
        >
          <div className="flex items-center gap-2">
            <FontAwesomeIcon
              className={[
                'h-3.5 w-3.5',
                selected ? 'text-[color:var(--accent)]' : 'text-[color:var(--tx3)]',
              ].join(' ')}
              icon={TRIGGER_TYPE_ICONS[option.value]}
            />
            <span className="text-sm font-semibold text-[var(--tx)]">{option.label}</span>
          </div>
          <div className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
            {option.description}
          </div>
        </button>
      )
    })}
  </div>
)
