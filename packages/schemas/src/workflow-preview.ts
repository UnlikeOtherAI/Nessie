import { z } from 'zod'

/** Server-stamped pointer for a live workflow diagram embedded in a message. */
export const WorkflowPreviewMessageMetadataSchema = z.object({
  workflowPreview: z.object({
    workflowTemplateId: z.string().uuid(),
  }),
})
export type WorkflowPreviewMessageMetadata = z.infer<typeof WorkflowPreviewMessageMetadataSchema>
