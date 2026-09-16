import { faFolderPlus, faGear, faTable } from '@fortawesome/free-solid-svg-icons'
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
  ownerAgentId?: string | null
  onCreateFolder: () => void
  onCreatePage: () => void
  onCreateSpreadsheet: () => void
  onImportSpreadsheet: () => void
  onOpenAgent: (agentId: string) => void
  onOpenSettings: () => void
  onSelectView: (mode: KnowledgeViewMode) => void
  onToggleNeedsReview: () => void
  onUploadFile: () => void
  scopeAgentId?: string
  selectedSpaceId?: string
  viewMode: KnowledgeViewMode
}

/** The shared space-base header, parameterised by the selected space verdict. */
export const buildKnowledgeWorkspaceActions = (
  input: WorkspaceActionInput,
): PageHeaderAction[] | undefined => {
  if (!input.selectedSpaceId) return undefined
  const selectedView = knowledgeViewOptions.find((option) => option.value === input.viewMode)
  const ownerAgentId = input.ownerAgentId
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
    ...(ownerAgentId && ownerAgentId !== input.scopeAgentId
      ? [{
          id: 'open-agent',
          label: 'Open agent',
          onSelect: () => input.onOpenAgent(ownerAgentId),
          priority: 50,
        } satisfies PageHeaderAction]
      : []),
    ...(input.canWrite
      ? [
          // "Upload file" is a menu rather than a button because importing a
          // workbook is the same gesture with a different destination: the
          // bytes become a spreadsheet document instead of a file node.
          {
            id: 'upload-file',
            items: [
              {
                id: 'upload-file-node',
                label: 'Upload file',
                onSelect: input.onUploadFile,
              },
              {
                icon: faTable,
                id: 'import-spreadsheet',
                label: 'Import spreadsheet…',
                onSelect: input.onImportSpreadsheet,
                title: 'An .xlsx, .csv or .tsv file becomes a spreadsheet document',
              },
            ],
            kind: 'menu',
            label: 'Upload file',
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
            icon: faTable,
            id: 'new-spreadsheet',
            label: 'New spreadsheet',
            onSelect: input.onCreateSpreadsheet,
            priority: 90,
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
