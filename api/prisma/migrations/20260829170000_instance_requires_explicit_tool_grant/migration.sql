-- Installing an app is not the same decision as letting an agent use it.
--
-- The brief separates INSTALL APP from ASSIGN TO AGENT, and the worker already
-- has the mechanism: a tool registry row flagged `requiresExplicitGrant` is
-- invisible to an agent until that agent's `toolPolicy` carries an explicit
-- allow (`worker/src/run/mcp-toolset.ts` `isExposed`). DeepWater has used it
-- since it shipped.
--
-- What was missing is a durable place to record that a given connection wants
-- that treatment. Stamping the flag at the App Store's own projection call
-- sites does not survive: four call sites reach `projectMcpToolDescriptors`,
-- and two of them (the OAuth callback, and the generic instance test/refresh
-- the Connectors page uses) are shared — so the very next refresh would
-- re-project the rows open and silently widen the app.
--
-- Default false, deliberately. Every connector that exists today keeps exactly
-- the exposure it has, and no agent loses a tool it is currently using; only
-- connections created through the App Store opt in.
ALTER TABLE "mcp_server_instances"
  ADD COLUMN "requires_explicit_tool_grant" BOOLEAN NOT NULL DEFAULT false;
