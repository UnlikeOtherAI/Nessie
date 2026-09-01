import { z } from 'zod'

export type DeepWaterHandoffMarker =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'found'; runId: string }

const ProductRunIdSchema = z.string().uuid()

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

/** Read only the server-authored DeepWater launch marker from message metadata. */
export const resolveDeepWaterHandoffMarker = (
  metadata: unknown,
): DeepWaterHandoffMarker => {
  const launch = record(record(metadata)?.integrationLaunch)
  if (launch?.productSlug !== 'deep-water') return { kind: 'none' }

  const parsed = ProductRunIdSchema.safeParse(launch.runId)
  return parsed.success
    ? { kind: 'found', runId: parsed.data }
    : { kind: 'invalid' }
}
