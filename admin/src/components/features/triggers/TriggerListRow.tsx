import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentTriggerRecord } from '../../../lib/api-client'
import { Pill } from '../../primitives/Pill'
import {
  TRIGGER_TYPE_ICONS,
  formatRelativeTime,
  formatTriggerTarget,
  getScheduleSummary,
  getTriggerTone,
  getTriggerTypeLabel,
  type TriggerRegistryMaps,
} from './trigger-presentation'

type TriggerListRowProps = {
  onOpen: (triggerId: string) => void
  registry: TriggerRegistryMaps
  trigger: AgentTriggerRecord
}

// One trigger row: the type icon, the trigger's name over the one scan line
// that compresses its schedule and its target, the status it is in, what kind
// of trigger it is, when it next fires, and a far-right chevron. The whole row
// opens trigger detail, which owns running, pausing, editing and deleting it.
export const TriggerListRow = ({ onOpen, registry, trigger }: TriggerListRowProps) => {
  const nextRun = trigger.enabled ? formatRelativeTime(trigger.nextRunAt) : undefined

  return (
    <tr
      className="cursor-pointer"
      onClick={() => onOpen(trigger.id)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(trigger.id)
        }
      }}
    >
      <td className="w-9 py-2.5 pl-4 pr-0 align-middle">
        <FontAwesomeIcon
          className="h-3 w-3 text-[color:var(--tx3)]"
          icon={TRIGGER_TYPE_ICONS[trigger.type]}
        />
      </td>
      <td className="min-w-0 px-3 py-2.5 align-middle">
        <div className="truncate text-sm font-medium text-[color:var(--tx)]">
          {trigger.name ?? trigger.type}
        </div>
        <div className="truncate text-xs text-[color:var(--tx3)]">
          {getScheduleSummary(trigger)} · {formatTriggerTarget(trigger, registry)}
        </div>
      </td>
      <td className="w-40 px-3 py-2.5 align-middle">
        <Pill height="control" tone={getTriggerTone(trigger.status)} uppercase={false}>
          {trigger.status}
        </Pill>
      </td>
      <td className="hidden w-40 px-3 py-2.5 align-middle text-xs text-[color:var(--tx2)] md:table-cell">
        {getTriggerTypeLabel(trigger)}
      </td>
      <td className="hidden w-32 px-3 py-2.5 align-middle text-xs tabular-nums text-[color:var(--tx3)] lg:table-cell">
        {nextRun ?? '—'}
      </td>
      <td className="w-9 py-2.5 pl-0 pr-4 text-right align-middle">
        <FontAwesomeIcon className="h-3 w-3 text-[color:var(--tx3)]" icon={faChevronRight} />
      </td>
    </tr>
  )
}
