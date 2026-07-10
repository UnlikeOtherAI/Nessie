-- External-agent groundwork: a run mode that proxies a channel's turns to an
-- external product over MCP (no Nessie inference), plus a system channel type
-- for the resulting per-user DM surface. Additive only — every existing agent
-- keeps `execution_mode = 'inference'`.

CREATE TYPE "AgentExecutionMode" AS ENUM (
  'inference',
  'external_mcp'
);

ALTER TABLE "agents"
  ADD COLUMN "execution_mode" "AgentExecutionMode" NOT NULL DEFAULT 'inference';

ALTER TYPE "ChannelSystemType" ADD VALUE IF NOT EXISTS 'external_agent';
