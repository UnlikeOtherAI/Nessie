import { faSignal } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { TaskPriority } from '../../../../facades/tasks/hooks'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { TabBar, type TabBarItem } from '../../../primitives/TabBar'
import { PRIORITY_LABEL, PRIORITY_ORDER, PRIORITY_SIGNAL } from './task-meta'

const priorityItems: ReadonlyArray<TabBarItem<TaskPriority>> = PRIORITY_ORDER.map((value) => ({
  icon: <FontAwesomeIcon className={`text-[11px] ${PRIORITY_SIGNAL[value]}`} icon={faSignal} />,
  label: PRIORITY_LABEL[value],
  value,
}))

export const TaskPriorityField = ({
  onChange,
  value,
}: {
  onChange: (priority: TaskPriority) => void
  value: TaskPriority
}) => (
  <div className="grid gap-1.5">
    <SectionLabel as="span" size="sm">Priority</SectionLabel>
    <TabBar
      ariaLabel="Priority"
      fullWidth
      items={priorityItems}
      onChange={onChange}
      role="radiogroup"
      size="sm"
      value={value}
    />
  </div>
)
