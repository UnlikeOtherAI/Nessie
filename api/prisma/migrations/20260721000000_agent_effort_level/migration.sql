-- Per-agent effort level: scales the worker agentic-loop run budget
-- (iterations / tool calls / wallclock / tokens / cost) and the provider
-- `reasoning_effort`. Modeled on OpenAI Codex's reasoning-effort levels.
-- Additive only — every existing agent keeps the default `medium`.

CREATE TYPE "AgentEffort" AS ENUM (
  'low',
  'medium',
  'high',
  'xhigh'
);

ALTER TABLE "agents"
  ADD COLUMN "effort" "AgentEffort" NOT NULL DEFAULT 'medium';
