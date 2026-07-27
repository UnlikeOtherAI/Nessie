import { faCheck, faPlay } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { DEFAULT_WORKFLOW_NAME } from '../../../lib/workflow-designer/constants'
import type { WorkflowTestRunState } from '../../../pages/workflow-designer/useWorkflowTestRun'

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
  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b border-[var(--line)] bg-[var(--surface-inverse)] px-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <button
          className={[
            'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded',
            'text-[var(--tx3)] transition-colors',
            'hover:bg-[var(--surface-inverse-2)] hover:text-[var(--ink)]',
          ].join(' ')}
          onClick={onBack}
          title="Back"
          type="button"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path
              d="M19 12H5M12 19l-7-7 7-7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <input
          aria-label="Workflow name"
          className="w-full max-w-xl border-none bg-[color:var(--surface-inverse)]/0 text-[15px] font-semibold text-[var(--ink)] outline-none placeholder:text-[var(--tx3)]"
          onChange={(event) => onWorkflowNameChange(event.target.value)}
          placeholder={DEFAULT_WORKFLOW_NAME}
          value={workflowName}
        />
      </div>

      <div className="flex items-center gap-3">
        <div className="max-w-[320px] min-w-[96px] truncate text-right text-[11px] text-[var(--muted)]">
          {isWorkflowTemplateLoading ? (
            'Loading workflow...'
          ) : saveError ? (
            <span className="text-[var(--danger)]" title={saveError}>
              {saveError}
            </span>
          ) : saveMessage ? (
            <span className="inline-flex items-center gap-1">
              <FontAwesomeIcon className="text-[10px]" icon={faCheck} />
              {saveMessage}
            </span>
          ) : workflowTemplateId ? (
            'Saved workflow'
          ) : (
            'New workflow'
          )}
        </div>

        <label className="flex items-center gap-2 text-[11px] font-medium text-[var(--muted)]">
          <span>Auto save</span>
          <button
            aria-label="Toggle auto save"
            aria-pressed={autoSaveDraft}
            className={[
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              autoSaveDraft ? 'bg-[var(--accent-hover)]' : 'bg-[var(--line)]',
            ].join(' ')}
            onClick={onToggleAutoSaveDraft}
            type="button"
          >
            <span
              className={[
                'inline-block h-5 w-5 rounded-full bg-[var(--surface-inverse)] shadow transition-transform',
                autoSaveDraft ? 'translate-x-5' : 'translate-x-1',
              ].join(' ')}
            />
          </button>
        </label>

        <button
          className="admin-button admin-button-secondary gap-1.5"
          disabled={!hasWorkflowToSave || isTestRunBusy || isSavingWorkflow}
          onClick={onTestRun}
          type="button"
        >
          <FontAwesomeIcon className="text-[10px]" icon={faPlay} />
          {TEST_RUN_LABELS[testRunState]}
        </button>

        <button
          className="admin-button admin-button-primary min-w-[88px]"
          disabled={!hasWorkflowToSave || isSavingWorkflow}
          onClick={onSave}
          type="button"
        >
          {isSavingWorkflow ? 'Saving...' : 'Save'}
        </button>
      </div>
    </header>
  )
}
