import { faCheck } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { DEFAULT_WORKFLOW_NAME } from '../../../lib/workflow-designer/constants'

type WorkflowDesignerHeaderProps = {
  workflowName: string
  onWorkflowNameChange: (value: string) => void
  isWorkflowTemplateLoading: boolean
  saveMessage: string | null
  workflowTemplateId?: string
  autoSaveDraft: boolean
  onToggleAutoSaveDraft: () => void
  hasWorkflowToSave: boolean
  isSavingWorkflow: boolean
  onBack: () => void
  onSave: () => void
}

export const WorkflowDesignerHeader = ({
  workflowName,
  onWorkflowNameChange,
  isWorkflowTemplateLoading,
  saveMessage,
  workflowTemplateId,
  autoSaveDraft,
  onToggleAutoSaveDraft,
  hasWorkflowToSave,
  isSavingWorkflow,
  onBack,
  onSave,
}: WorkflowDesignerHeaderProps) => {
  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b border-black/8 bg-white px-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <button
          className={[
            'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded',
            'text-[#8b7a93] transition-colors',
            'hover:bg-[#f4eff8] hover:text-[#2f2237]',
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
          className="w-full max-w-xl border-none bg-transparent text-[15px] font-semibold text-[#2f2237] outline-none placeholder:text-[#9a8aa2]"
          onChange={(event) => onWorkflowNameChange(event.target.value)}
          placeholder={DEFAULT_WORKFLOW_NAME}
          value={workflowName}
        />
      </div>

      <div className="flex items-center gap-3">
        <div className="min-w-[96px] text-right text-[11px] text-[#7c6b86]">
          {isWorkflowTemplateLoading ? (
            'Loading workflow...'
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

        <label className="flex items-center gap-2 text-[11px] font-medium text-[#5f4e67]">
          <span>Auto save</span>
          <button
            aria-label="Toggle auto save"
            aria-pressed={autoSaveDraft}
            className={[
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              autoSaveDraft ? 'bg-[#7445c7]' : 'bg-[#d9d1df]',
            ].join(' ')}
            onClick={onToggleAutoSaveDraft}
            type="button"
          >
            <span
              className={[
                'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
                autoSaveDraft ? 'translate-x-5' : 'translate-x-1',
              ].join(' ')}
            />
          </button>
        </label>

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
