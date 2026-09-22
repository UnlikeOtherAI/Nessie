-- `none` switches an agent's separate thinking off wherever its provider
-- offers a switch (DeepSeek `thinking.type`, DashScope `enable_thinking`,
-- Ollama `think`) and sends no reasoning effort at all elsewhere. It is the
-- one level every connector dialect reads as "off" rather than "how much";
-- see docs/standards/inference-reasoning.md. Additive: no agent changes level.
ALTER TYPE "AgentEffort" ADD VALUE IF NOT EXISTS 'none';
