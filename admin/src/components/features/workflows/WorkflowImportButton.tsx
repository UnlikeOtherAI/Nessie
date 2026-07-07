import { useRef, useState } from 'react'
import type { WorkflowTemplateRecord } from '../../../lib/api-client'
import { useCreateWorkflowTemplate } from '../../../facades/workflows/hooks'
import { parseWorkflowImport } from './workflow-transfer'

/**
 * Imports a workflow template from a JSON file exported via
 * `downloadWorkflowExport`. Lives beside the search input in the workflows
 * list column — a secondary action, not the header's primary "New workflow".
 */

type WorkflowImportButtonProps = {
  onImported: (template: WorkflowTemplateRecord) => void
}

export const WorkflowImportButton = ({ onImported }: WorkflowImportButtonProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | undefined>()
  const createWorkflowTemplate = useCreateWorkflowTemplate()

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(undefined)
    const file = event.target.files?.[0]
    // Reset so selecting the same file again still fires onChange.
    event.target.value = ''
    if (!file) return

    let raw: string
    try {
      raw = await file.text()
    } catch {
      setError('Could not read that file.')
      return
    }

    const result = parseWorkflowImport(raw)
    if (!result.ok) {
      setError(result.error)
      return
    }

    createWorkflowTemplate.mutate(
      {
        name: result.value.name,
        description: result.value.description,
        graph: result.value.graph,
        triggers: result.value.triggers,
      },
      {
        onSuccess: (template) => onImported(template),
        onError: () => setError('Import failed — the workflow could not be created.'),
      },
    )
  }

  return (
    <div className="grid gap-2">
      <button
        className="admin-button admin-button-secondary"
        disabled={createWorkflowTemplate.isPending}
        onClick={() => fileInputRef.current?.click()}
        type="button"
      >
        {createWorkflowTemplate.isPending ? 'Importing…' : 'Import'}
      </button>
      <input
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => void handleFileChange(event)}
        ref={fileInputRef}
        type="file"
      />
      {error ? (
        <div className="rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger-text)]">
          {error}
        </div>
      ) : null}
    </div>
  )
}
