import { z } from 'zod'

/**
 * A product integration run changed — for a DeepWater research, its planner
 * answered, the research started or finished, its result was delivered or its
 * delivery was blocked (Water plan nessie.md §7.7).
 *
 * Content-free on purpose: the product and the run id, nothing else, and
 * strict so nothing more can ride along. The client refetches through the
 * viewer-scoped read (`GET …/research-runs/:runId`), the only place a run's
 * topic, brief or result is disclosed. It is published on the requester's user
 * lane, and on the origin channel's lane once the run has a card there (or an
 * agent opened it there), so there is no client polling. A new name inside the
 * unchanged envelope, so a replica or client that predates it ignores it.
 */
export const IntegrationRunUpdatedEventSchema = z
  .object({
    productSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    runId: z.string().uuid(),
  })
  .strict()
export type IntegrationRunUpdatedEvent = z.infer<typeof IntegrationRunUpdatedEventSchema>
