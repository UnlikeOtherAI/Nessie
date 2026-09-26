import { faSignal } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useTranslation } from 'react-i18next'
import type { TaskPriority } from '../../../../facades/tasks/hooks'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { TabBar, type TabBarItem } from '../../../primitives/TabBar'
import { PRIORITY_ORDER, PRIORITY_SIGNAL } from './task-meta'

export const TaskPriorityField = ({
  onChange,
  value,
}: {
  onChange: (priority: TaskPriority) => void
  value: TaskPriority
}) => {
  const { t } = useTranslation('projects')
  const priorityItems: ReadonlyArray<TabBarItem<TaskPriority>> = PRIORITY_ORDER.map((priority) => ({
    icon: <FontAwesomeIcon className={`text-[11px] ${PRIORITY_SIGNAL[priority]}`} icon={faSignal} />,
    label: t(`taskDialog.priority.${priority}`),
    value: priority,
  }))
  return (
    <div className="grid gap-1.5">
      <SectionLabel as="span" size="sm">{t('taskDialog.priority.label')}</SectionLabel>
      <TabBar
        ariaLabel={t('taskDialog.priority.label')}
        fullWidth
        items={priorityItems}
        onChange={onChange}
        role="radiogroup"
        size="sm"
        value={value}
      />
    </div>
  )
}
