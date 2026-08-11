import {
  ResponsivePageHeader,
  type PageHeaderAction,
} from '../../shared/ResponsivePageHeader'
import type { ToolbarAction, ToolbarMenuItem } from '../../../lib/workflow-designer/types'

type WorkflowToolbarProps = {
  onMenuItemClick: (item: ToolbarMenuItem) => void
  toolbarActions: ToolbarAction[]
}

// The designer's source menus use the same overflowable action model as every
// other header. Each category remains a menu, and its creation shortcut stays
// first, but low-priority categories now move into More when the canvas narrows.
export const WorkflowToolbar = ({ onMenuItemClick, toolbarActions }: WorkflowToolbarProps) => {
  const actions: PageHeaderAction[] = toolbarActions.map((action, index) => ({
    icon: action.icon,
    id: action.key,
    items: [
      ...(action.createItem ? [{
        icon: action.createItem.icon,
        id: `${action.key}:${action.createItem.key}`,
        label: action.createItem.label,
        onSelect: () => onMenuItemClick(action.createItem!),
      }] : []),
      ...action.items.map((item) => ({
        icon: item.icon,
        id: `${action.key}:${item.key}`,
        label: item.meta ? `${item.label} — ${item.meta}` : item.label,
        onSelect: () => onMenuItemClick(item),
      })),
      ...(action.items.length === 0 ? [{
        disabled: true,
        id: `${action.key}:empty`,
        label: action.emptyLabel,
        onSelect: () => undefined,
      }] : []),
    ],
    kind: 'menu',
    label: action.label,
    priority: 100 - index,
    title: action.sectionLabel,
  }))

  return <ResponsivePageHeader actions={actions} title="Add workflow node" titleTone="section" />
}
