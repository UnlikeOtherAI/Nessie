import { faPlay } from '@fortawesome/free-solid-svg-icons'
import { DEFAULT_WORKFLOW_NAME } from '../../../lib/workflow-designer/constants'
import type { WorkflowTestRunState } from '../../../pages/workflow-designer/useWorkflowTestRun'
import {
  ResponsivePageHeader,
  type PageHeaderAction,
} from '../../shared/ResponsivePageHeader'
import { useNativeBarHeader } from '../../../navigation/useNativeBarHeader'
import { toScreenBarActions } from '../../../navigation/screen-bar-actions'

type WorkflowDesignerHeaderProps = {
  workflowName: string
  onWorkflowNameChange: (value: string) => void
  isWorkflowTemplateLoading: boolean
  saveError: string | null
  saveMessage: string | null
  workflowTemplateId?: string
  autoSaveDraft: boolean
  onToggleAutoSaveDraft: () => void
  hasWorkflowToSave: boolean
  isSavingWorkflow: boolean
  onBack: () => void
  onSave: () => void
  onTestRun: () => void
  testRunState: WorkflowTestRunState
  // A save the server refused as stale. The two answers replace Save in place —
  // never a blocking dialog (docs/navigation/overview.md → "Drafts").
  versionConflict: boolean
  onKeepMine: () => void
  onTakeTheirs: () => void
}

const TEST_RUN_LABELS: Record<WorkflowTestRunState, string> = {
  completed: 'Test run',
  failed: 'Test run',
  idle: 'Test run',
  running: 'Running…',
  starting: 'Starting…',
}

export const WorkflowDesignerHeader = ({
  workflowName,
  onWorkflowNameChange,
  isWorkflowTemplateLoading,
  saveError,
  saveMessage,
  workflowTemplateId,
  autoSaveDraft,
  onToggleAutoSaveDraft,
  hasWorkflowToSave,
  isSavingWorkflow,
  onBack,
  onKeepMine,
  onSave,
  onTakeTheirs,
  onTestRun,
  testRunState,
  versionConflict,
}: WorkflowDesignerHeaderProps) => {
  const isTestRunBusy = testRunState === 'starting' || testRunState === 'running'
  const status = isWorkflowTemplateLoading
    ? 'Loading workflow'
    : versionConflict
      ? 'Somebody else saved this workflow — your canvas is kept'
      : saveError
        ? saveError
        : saveMessage ?? (workflowTemplateId ? 'Saved workflow' : 'New workflow')
  const actions: PageHeaderAction[] = [
    {
      id: 'auto-save',
      label: 'Auto save',
      onSelect: onToggleAutoSaveDraft,
      pressed: autoSaveDraft,
      priority: 40,
      selected: autoSaveDraft,
    },
    {
      disabled: !hasWorkflowToSave || isTestRunBusy || isSavingWorkflow,
      icon: faPlay,
      id: 'test-run',
      label: TEST_RUN_LABELS[testRunState],
      onSelect: onTestRun,
      priority: 70,
    },
    ...(versionConflict
      ? [
        {
          id: 'take-theirs',
          label: 'Take theirs',
          onSelect: onTakeTheirs,
          priority: 90,
        },
        {
          disabled: isSavingWorkflow,
          id: 'keep-mine',
          label: isSavingWorkflow ? 'Saving...' : 'Keep mine',
          onSelect: onKeepMine,
          primary: true,
          priority: 100,
        },
      ]
      : [
        {
          disabled: !hasWorkflowToSave || isSavingWorkflow,
          id: 'save',
          label: isSavingWorkflow ? 'Saving...' : 'Save',
          onSelect: onSave,
          primary: true,
          priority: 100,
        },
      ]),
  ]

  // The designer is a Flow that owns its Back — it returns to the list it was
  // opened from, an address the route registry cannot name — so the bar
  // publishes that handler rather than the resolver's answer.
  const { hidden } = useNativeBarHeader({
    actions: toScreenBarActions(actions),
    back: { label: 'Back', onBack },
    title: workflowName || DEFAULT_WORKFLOW_NAME,
  })

  const titleInput = {
    ariaLabel: 'Workflow name',
    onChange: onWorkflowNameChange,
    placeholder: DEFAULT_WORKFLOW_NAME,
    value: workflowName,
  }

  if (hidden) {
    // A text field has no lane in a native bar, and the save status is content
    // rather than chrome. Both stay with the page, under the bar. The heading
    // stays too, and stays an `h1`: the settle focuses it and the live region
    // reads it (navigation/settle.ts) by `querySelector('h1')`.
    return (
      <div className="flex min-w-0 flex-col gap-1 px-4 pb-2 pt-3">
        <h1 className="sr-only">{workflowName || DEFAULT_WORKFLOW_NAME}</h1>
        <input
          aria-label={titleInput.ariaLabel}
          className={[
            'w-full min-w-0 truncate border-0 bg-transparent p-0 text-[17px] font-bold',
            'text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)]',
          ].join(' ')}
          onChange={(event) => titleInput.onChange(event.target.value)}
          placeholder={titleInput.placeholder}
          value={titleInput.value}
        />
        {status ? (
          <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-[color:var(--tx2)]">
            {status}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <ResponsivePageHeader
      actions={actions}
      eyebrow={status}
      onBack={onBack}
      title="Workflow Designer"
      titleInput={titleInput}
    />
  )
}
