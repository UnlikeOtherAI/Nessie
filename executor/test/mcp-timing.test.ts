import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EXECUTOR_COMMAND_OVERHEAD_MS,
  EXECUTOR_MCP_COMMAND_TTL_MS,
  EXECUTOR_MCP_UPLOAD_BUDGET_MS,
  EXECUTOR_TOOL_TIMEOUT_MARGIN_MS,
} from '@nessie/schemas'

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
