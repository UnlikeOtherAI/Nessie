import {
  ExecutorAccessViewResponseSchema,
  ExecutorDescriptorReviewResponseSchema,
} from '@nessie/schemas'
import type {
  ExecutorAccessViewResponse,
  ExecutorDescriptorReviewResponse,
} from '@nessie/schemas'

/**
 * The access view this surface reads, which is now simply the wire contract.
 *
 * These were local extensions while the control plane had not yet served
 * `descriptorRevisions[].mcpServers` and `localMcp`. Both are in
 * `@nessie/schemas` and served by `packages/executor-manage`, so the aliases
 * stay only to keep one name for the shape across the components; they add
 * nothing to it.
 */
export const ExecutorDescriptorReviewWithMcpSchema = ExecutorDescriptorReviewResponseSchema
export type ExecutorDescriptorRevisionView = ExecutorDescriptorReviewResponse

export const ExecutorAccessViewWithLocalMcpSchema = ExecutorAccessViewResponseSchema
export type ExecutorAccessViewWithLocalMcp = ExecutorAccessViewResponse
