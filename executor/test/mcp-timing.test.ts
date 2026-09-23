import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EXECUTOR_COMMAND_OVERHEAD_MS,
  EXECUTOR_MCP_COMMAND_TTL_MS,
  EXECUTOR_MCP_UPLOAD_BUDGET_MS,
  EXECUTOR_RESULT_IMAGE_MAXIMUM,
  EXECUTOR_RESULT_IMAGE_MAX_BYTES,
  EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES,
  EXECUTOR_TOOL_TIMEOUT_MARGIN_MS,
} from '@nessie/schemas'

import { executorAttachmentUploadTimeoutMs } from '../src/command-attachments.js'
import { EXECUTOR_MCP_DAEMON_COMMAND_WORST_CASE_MS } from '../src/mcp-session-manager.js'

/**
 * The worker stamps each `mcp.*` command with an expiry; the daemon spends at
 * most its composed worst case on one. When the expiry is the shorter, a call
 * still legitimately running on the machine expires into an unknown outcome
 * and aborts the run. The worst case is the session manager's own statement of
 * its sequence — a cold start, then one call deadline, the whole tools/list
 * walk included — and `mcp-session-manager.test.ts` drives a slow server
 * through both halves of that claim.
 */
test('an mcp command outlives the daemon’s worst case, its uploads and the lane’s hops', () => {
  assert.ok(
    EXECUTOR_MCP_COMMAND_TTL_MS
      >= EXECUTOR_MCP_DAEMON_COMMAND_WORST_CASE_MS + EXECUTOR_MCP_UPLOAD_BUDGET_MS + EXECUTOR_COMMAND_OVERHEAD_MS,
    `TTL ${EXECUTOR_MCP_COMMAND_TTL_MS} ms < daemon ${EXECUTOR_MCP_DAEMON_COMMAND_WORST_CASE_MS} ms + uploads + hops`,
  )
  // The worker's backstop sits past the expiry, so the expiry is what ends a
  // slow command and the backstop only one that stopped making progress.
  assert.ok(EXECUTOR_TOOL_TIMEOUT_MARGIN_MS > 0)
})

/**
 * The upload budget above is what a result's image uploads may spend. Each
 * upload's own deadline grows with its size, and the sum of one result's —
 * at most six images, 8 MiB together — stays inside that budget however the
 * bytes are split.
 */
test('one result’s image uploads fit the upload budget however its bytes are split', () => {
  const total = EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES
  const splits = [
    Array.from({ length: EXECUTOR_RESULT_IMAGE_MAXIMUM }, () => 1),
    Array.from({ length: EXECUTOR_RESULT_IMAGE_MAXIMUM }, () => Math.floor(total / EXECUTOR_RESULT_IMAGE_MAXIMUM)),
    [EXECUTOR_RESULT_IMAGE_MAX_BYTES, EXECUTOR_RESULT_IMAGE_MAX_BYTES],
    [EXECUTOR_RESULT_IMAGE_MAX_BYTES, 1, 1, 1, 1, EXECUTOR_RESULT_IMAGE_MAX_BYTES - 4],
  ]
  for (const split of splits) {
    const spent = split.reduce((sum, bytes) => sum + executorAttachmentUploadTimeoutMs(bytes), 0)
    assert.ok(spent <= EXECUTOR_MCP_UPLOAD_BUDGET_MS, `${split.join('+')} bytes may take ${spent} ms`)
  }
  assert.ok(executorAttachmentUploadTimeoutMs(4 * 1024 * 1024) > executorAttachmentUploadTimeoutMs(13_715))
  assert.ok(executorAttachmentUploadTimeoutMs(1) >= 2_000, 'even a tiny image gets time for the round trip')
})
