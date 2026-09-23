import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import { ChoiceGroup, type ChoiceOption } from '../../shared/ChoiceGroup'
import { TRIGGER_TYPE_ICONS } from './trigger-presentation'

/**
 * Radio-card picker for the trigger type in create mode. Each card explains
 * what the type does so operators do not need to know the internals.
 *
 * It serves the agent and the workflow editors alike, and a ticket trigger is
 * agent-only (docs/standards/ticket-work.md → "Nothing is half-exposed"), so
 * "Ticket change" is offered only for an agent target. `document_changed` is
 * not offered anywhere until it ships its editor (T2).
 */

type TriggerType = AgentTriggerRecord['type']

type TriggerTypePickerProps = {
  onChange: (type: TriggerType) => void
  /** True for an agent target: the only target a ticket trigger can wake. */
  offerTicketChanged?: boolean
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

const TICKET_CHANGED_OPTION: ChoiceOption<TriggerType> = {
  value: 'ticket_changed',
  label: 'Ticket change',
  description: 'Starts work when a person moves a ticket into a start-work column.',
  icon: <FontAwesomeIcon icon={TRIGGER_TYPE_ICONS.ticket_changed} />,
}

export const TriggerTypePicker = ({ offerTicketChanged = false, onChange, value }: TriggerTypePickerProps) => (
  <ChoiceGroup
    label="Trigger type"
    labelHidden
    onChange={onChange}
    options={offerTicketChanged ? [...TYPE_OPTIONS, TICKET_CHANGED_OPTION] : TYPE_OPTIONS}
    value={value}
    variant="card"
  />
)
