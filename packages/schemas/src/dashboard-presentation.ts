import { z } from 'zod'

/**
 * A dashboard pointer on an agent-authored message.
 *
 * The message carries an id rather than a rendered dashboard or data. The
 * client still reads the dashboard through its normal, viewer-scoped endpoint,
 * so presenting a dashboard in chat never grants access to it.
 */
export const DashboardPresentationMessageMetadataSchema = z
  .object({
    dashboardPresentation: z
      .object({
        dashboardId: z.string().uuid(),
        schemaVersion: z.literal(1),
      })
      .strict(),
  })
  .strict()

export type DashboardPresentationMessageMetadata = z.infer<
  typeof DashboardPresentationMessageMetadataSchema
>
