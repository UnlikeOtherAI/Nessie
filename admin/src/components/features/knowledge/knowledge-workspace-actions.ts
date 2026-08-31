import { faFolderPlus, faGear } from '@fortawesome/free-solid-svg-icons'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'
import {
  knowledgeViewOptions,
  type KnowledgeViewMode,
} from './KnowledgeViewToggle'

type WorkspaceActionInput = {
  agentDraftCount: number
  canManageSpace: boolean
  canWrite: boolean
  needsReviewOnly: boolean
  onCreateFolder: () => void
  onCreatePage: () => void
  onOpenAgent?: () => void
  onOpenSettings: () => void
  onSelectView: (mode: KnowledgeViewMode) => void
  onToggleNeedsReview: () => void
  onUploadFile: () => void
  selectedSpaceId?: string
  viewMode: KnowledgeViewMode
}

/** The shared space-base header, parameterised by the selected space verdict. */
export const buildKnowledgeWorkspaceActions = (
  input: WorkspaceActionInput,
): PageHeaderAction[] | undefined => {
  if (!input.selectedSpaceId) return undefined
  const selectedView = knowledgeViewOptions.find((option) => option.value === input.viewMode)
  return [
    {
      icon: selectedView?.icon,
      id: 'view-mode',
      items: knowledgeViewOptions.map((option) => ({
        checked: option.value === input.viewMode,
        icon: option.icon,
        id: option.value,
        label: option.label,
        onSelect: () => input.onSelectView(option.value),
        title: option.title,
      })),
      kind: 'menu',
      label: `View: ${selectedView?.label ?? 'Column'}`,
      priority: 80,
      title: 'Choose knowledge view',
    },
    ...(input.agentDraftCount > 0 || input.needsReviewOnly
      ? [{
          id: 'needs-review',
          label: `Needs review (${input.agentDraftCount})`,
          onSelect: input.onToggleNeedsReview,
          priority: 60,
          selected: input.needsReviewOnly,
        } satisfies PageHeaderAction]
      : []),
    ...(input.onOpenAgent
      ? [{
          id: 'open-agent',
          label: 'Open agent',
          onSelect: input.onOpenAgent,
          priority: 50,
        } satisfies PageHeaderAction]
      : []),
    ...(input.canWrite
      ? [
          {
            id: 'upload-file',
            label: 'Upload file',
            onSelect: input.onUploadFile,
            priority: 40,
          },
          {
            icon: faFolderPlus,
            id: 'new-folder',
            label: 'New folder',
            onSelect: input.onCreateFolder,
            priority: 30,
          },
          {
            id: 'new-page',
            label: 'New page',
            onSelect: input.onCreatePage,
            primary: true,
            priority: 100,
          },
        ] satisfies PageHeaderAction[]
      : []),
    ...(input.canManageSpace
      ? [{
          compact: true,
          icon: faGear,
          id: 'space-settings',
          label: 'Space settings',
          onSelect: input.onOpenSettings,
          priority: 10,
        } satisfies PageHeaderAction]
      : []),
  ]
}
