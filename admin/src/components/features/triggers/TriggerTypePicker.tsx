import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import { ChoiceGroup, type ChoiceOption } from '../../shared/ChoiceGroup'
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

const TYPE_OPTIONS: Array<ChoiceOption<TriggerType>> = [
  {
    value: 'manual',
    label: 'Manual',
    description: 'Fires only when you press “Run now”.',
    icon: <FontAwesomeIcon icon={TRIGGER_TYPE_ICONS.manual} />,
  },
  {
    value: 'scheduled',
    label: 'Schedule',
    description: 'Runs on a cron schedule or once at a set time.',
    icon: <FontAwesomeIcon icon={TRIGGER_TYPE_ICONS.scheduled} />,
  },
  {
    value: 'interval',
    label: 'Interval',
    description: 'Repeats every N minutes.',
    icon: <FontAwesomeIcon icon={TRIGGER_TYPE_ICONS.interval} />,
  },
  {
    value: 'webhook',
    label: 'Webhook',
    description: 'Fires when an external system calls an endpoint.',
    icon: <FontAwesomeIcon icon={TRIGGER_TYPE_ICONS.webhook} />,
  },
  {
    value: 'event',
    label: 'Event',
    description: 'Reacts to internal system events.',
    icon: <FontAwesomeIcon icon={TRIGGER_TYPE_ICONS.event} />,
  },
]

export const TriggerTypePicker = ({ onChange, value }: TriggerTypePickerProps) => (
  <ChoiceGroup
    label="Trigger type"
    labelHidden
    onChange={onChange}
    options={TYPE_OPTIONS}
    value={value}
    variant="card"
  />
)
