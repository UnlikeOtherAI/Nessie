import { WorkflowPreviewMessageMetadataSchema } from '@nessie/schemas'
import { useState } from 'react'

import { useWorkflowTemplate } from '../../../facades/workflows/hooks'
import { useIsOwner } from '../../../facades/auth/hooks'
import { Dialog } from '../../shared/Dialog'
import { WorkflowTemplatePreviewCanvas } from '../workflows/WorkflowTemplatePreviewCanvas'

/**
 * A message carries only a template pointer; the viewer fetches the live graph
 * under their own workflow-admin entitlement. The compact diagram and the
 * full-screen dialog therefore always render the same saved workflow.
 */
export const WorkflowPreviewCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const parsed = WorkflowPreviewMessageMetadataSchema.safeParse(metadata)
  const [open, setOpen] = useState(false)
  const isOwner = useIsOwner()
  const template = useWorkflowTemplate(
    parsed.success ? parsed.data.workflowPreview.workflowTemplateId : undefined,
    isOwner,
  )

  if (!parsed.success) return null
  if (!isOwner) {
    return (
      <section
        className="mt-2 max-w-2xl rounded-[var(--radius-lg)] border border-[color:var(--line)] bg-[color:var(--panel-soft)] p-3"
        data-testid="workflow-preview-restricted"
      >
        <p className="m-0 text-sm font-semibold text-[color:var(--tx1)]">Workflow preview</p>
        <p className="mb-0 mt-1 text-xs text-[color:var(--tx2)]">
          Workflow admin access is required to view this diagram.
        </p>
      </section>
    )
  }
  if (!template.data) return null

  const designerHref = `/agents/workflow-designer/${template.data.id}`
  return (
    <>
      <section
        className="mt-2 max-w-2xl rounded-[var(--radius-lg)] border border-[color:var(--line)] bg-[color:var(--panel-soft)] p-3"
        data-testid="workflow-preview-card"
      >
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 truncate text-sm font-semibold text-[color:var(--tx1)]">
              {template.data.name}
            </p>
            <p className="m-0 text-xs text-[color:var(--tx2)]">Workflow preview</p>
          </div>
          <a
            className="shrink-0 text-xs font-semibold text-[color:var(--thinking)] underline"
            href={designerHref}
            onClick={(event) => event.stopPropagation()}
          >
            Open in Admin
          </a>
        </div>
        <button
          aria-label={`Open ${template.data.name} workflow preview`}
          className="block w-full overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--line)] text-left transition-shadow hover:shadow-[0_8px_24px_var(--scrim-weak)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          onClick={(event) => {
            event.stopPropagation()
            setOpen(true)
          }}
          type="button"
        >
          <WorkflowTemplatePreviewCanvas compact template={template.data} />
        </button>
      </section>
      <Dialog
        description="A live, read-only view of the saved workflow."
        onClose={() => setOpen(false)}
        open={open}
        size="full"
        title={template.data.name}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <div className="min-h-0 flex-1 rounded-[var(--radius-md)] border border-[color:var(--line)]">
            <WorkflowTemplatePreviewCanvas template={template.data} />
          </div>
          <a
            className="w-fit text-sm font-semibold text-[color:var(--thinking)] underline"
            href={designerHref}
          >
            Open workflow in Admin
          </a>
        </div>
      </Dialog>
    </>
  )
}
