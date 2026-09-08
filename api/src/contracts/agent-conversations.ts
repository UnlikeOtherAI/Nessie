import { MAX_PAGE_LIMIT } from '@nessie/schemas'
import { z } from 'zod'

/**
 * The wire shape of the conversation routes that is the API's own.
 *
 * The record, the two bodies and the doorway metadata live in `@nessie/schemas`
 * because the worker and the admin import them too; what stays here is the
 * query string, whose every value arrives as text and has to be coerced before
 * it can be a limit.
 */
export const ListAgentConversationsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
})
export type ListAgentConversationsQuery = z.infer<typeof ListAgentConversationsQuerySchema>
