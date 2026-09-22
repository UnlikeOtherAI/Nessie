-- The availability-candidate CHECK enumerated the operation keys known on
-- 2026-08-12. `IMPLEMENTED_EXECUTOR_OPERATION_KEYS` has since gained
-- `workspace.review`, the connected-browser trio and the local MCP pair
-- (`mcp.tools`, `mcp.call`), so every availability request for those bundles
-- failed with SQLSTATE 23514 before any client could bind them. Widen the
-- constraint to the union of the historical list and the implemented keys.
ALTER TABLE "executor_availability_candidates"
  DROP CONSTRAINT "executor_availability_candidates_operation_keys_known",
  ADD CONSTRAINT "executor_availability_candidates_operation_keys_known"
    CHECK ("operation_keys" <@ ARRAY[
      'file.list', 'file.read', 'file.write', 'command.run',
      'browser.open', 'browser.observe', 'browser.act',
      'browser.connected.open', 'browser.connected.observe', 'browser.connected.act',
      'workspace.review', 'workspace.promote', 'sandbox.stop',
      'coding.launch', 'coding.attach', 'coding.observe', 'coding.prompt',
      'coding.interrupt', 'coding.close',
      'mcp.tools', 'mcp.call'
    ]::TEXT[]);
