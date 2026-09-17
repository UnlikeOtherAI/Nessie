import { z } from 'zod'
import {
  ExecutorAccessViewResponseSchema,
  ExecutorDescriptorReviewResponseSchema,
  ExecutorLocalMcpReportSchema,
  ExecutorMcpServerNamesSchema,
} from '@nessie/schemas'

/**
 * The access-view projection this surface is built against, ahead of the
 * control-plane change that serves it. Two additions are assumed, and both
 * are validated by the committed wire contract
 * (`packages/schemas/src/executor-mcp.ts`) rather than invented here:
 *
 * - `descriptorRevisions[].mcpServers` — the server names projected off the
 *   signed descriptor, exactly as `commandAllowlist` and `workspaceFolders`
 *   already are, so a reviewer reads the names a revision approves. Absent
 *   names none, which permits none; the contract carries no empty array.
 * - `localMcp` — the daemon's last heartbeat report, stored and echoed so
 *   the detail screen can show availability and Kelpie's instance inventory.
 *   Absent means the daemon has never reported (too old, or never connected);
 *   an empty array means it reports and names no server.
 *
 * When the API change lands in `@nessie/schemas` this module collapses back
 * to the plain view schema; until then the extension is the stub the fixtures
 * and the hook parse against.
 */
export const ExecutorDescriptorReviewWithMcpSchema = ExecutorDescriptorReviewResponseSchema
  .extend({
    mcpServers: ExecutorMcpServerNamesSchema.optional(),
  })
export type ExecutorDescriptorRevisionView = z.infer<typeof ExecutorDescriptorReviewWithMcpSchema>

export const ExecutorAccessViewWithLocalMcpSchema = ExecutorAccessViewResponseSchema.extend({
  descriptorRevisions: z.array(ExecutorDescriptorReviewWithMcpSchema).max(20).optional(),
  localMcp: ExecutorLocalMcpReportSchema.optional(),
})
export type ExecutorAccessViewWithLocalMcp = z.infer<typeof ExecutorAccessViewWithLocalMcpSchema>
