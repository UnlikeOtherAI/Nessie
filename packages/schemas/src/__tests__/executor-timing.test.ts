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

// The numbers the standards and the plan cite, pinned so an edit to one of
// them is an edit to those documents too. Whether the daemon's real sequence
// fits the command TTL is not something this package can see: the executor's
// own tests pin that against the deadlines its session manager composes
// (`executor/test/mcp-timing.test.ts`) and drive a slow server through them.
test('the local-MCP lane keeps the timing its standards state', () => {
  assert.deepEqual({
    call: EXECUTOR_MCP_CALL_TIMEOUT_MS,
    margin: EXECUTOR_TOOL_TIMEOUT_MARGIN_MS,
    overhead: EXECUTOR_COMMAND_OVERHEAD_MS,
    start: EXECUTOR_MCP_START_TIMEOUT_MS,
    ttl: EXECUTOR_MCP_COMMAND_TTL_MS,
    upload: EXECUTOR_MCP_UPLOAD_BUDGET_MS,
  }, {
    call: 60_000,
    margin: 10_000,
    overhead: 20_000,
    start: 10_000,
    ttl: 140_000,
    upload: 50_000,
  })
})
