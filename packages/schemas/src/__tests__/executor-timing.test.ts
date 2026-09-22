import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXECUTOR_COMMAND_OVERHEAD_MS,
  EXECUTOR_MCP_CALL_TIMEOUT_MS,
  EXECUTOR_MCP_COMMAND_TTL_MS,
  EXECUTOR_MCP_START_TIMEOUT_MS,
  EXECUTOR_MCP_UPLOAD_BUDGET_MS,
  EXECUTOR_TOOL_TIMEOUT_MARGIN_MS,
} from '../index.js'

// The daemon enforces the start and call timeouts; the worker stamps the
// command's expiry from the TTL. An edit to either side that breaks the
// inequality lets a call that is still legitimately running on the machine
// expire into an unknown outcome, which aborts the run.
test('an mcp command outlives everything that can happen to it', () => {
  assert.ok(
    EXECUTOR_MCP_COMMAND_TTL_MS
      >= EXECUTOR_MCP_START_TIMEOUT_MS
        + EXECUTOR_MCP_CALL_TIMEOUT_MS
        + EXECUTOR_MCP_UPLOAD_BUDGET_MS
        + EXECUTOR_COMMAND_OVERHEAD_MS,
    'the command TTL must cover a cold start, the call, its uploads and the lane overhead',
  )
  assert.equal(EXECUTOR_MCP_COMMAND_TTL_MS, 120_000)
})

test('the tool timeout sits past the command TTL, never inside it', () => {
  // The TTL raises the fatal, replay-safe unknown outcome. A tool timeout that
  // fired first would be the one to end the call instead.
  assert.ok(EXECUTOR_TOOL_TIMEOUT_MARGIN_MS > 0)
})
