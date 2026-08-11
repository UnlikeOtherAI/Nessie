import { faPlay } from '@fortawesome/free-solid-svg-icons'
import { DEFAULT_WORKFLOW_NAME } from '../../../lib/workflow-designer/constants'
import type { WorkflowTestRunState } from '../../../pages/workflow-designer/useWorkflowTestRun'
import {
  ResponsivePageHeader,
  type PageHeaderAction,
} from '../../shared/ResponsivePageHeader'

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
  onSave,
  onTestRun,
  testRunState,
}: WorkflowDesignerHeaderProps) => {
  const isTestRunBusy = testRunState === 'starting' || testRunState === 'running'
  const status = isWorkflowTemplateLoading
    ? 'Loading workflow'
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
    {
      disabled: !hasWorkflowToSave || isSavingWorkflow,
      id: 'save',
      label: isSavingWorkflow ? 'Saving...' : 'Save',
      onSelect: onSave,
      primary: true,
      priority: 100,
    },
  ]

  return (
    <ResponsivePageHeader
      actions={actions}
      eyebrow={status}
      onBack={onBack}
      title="Workflow Designer"
      titleInput={{
        ariaLabel: 'Workflow name',
        onChange: onWorkflowNameChange,
        placeholder: DEFAULT_WORKFLOW_NAME,
        value: workflowName,
      }}
    />
  )
}
