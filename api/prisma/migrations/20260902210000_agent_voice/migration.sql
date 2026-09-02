-- Per-agent voice and speaking style (Agent Designer → "Voice" and
-- "How the agent talks to you").
--
-- Both nullable with no default: NULL means "not chosen", which is a real
-- category rather than a missing value. `voice_name` then falls back to the
-- deployment default and `speaking_style` contributes no prompt block at all,
-- so every existing agent keeps its current behaviour byte-for-byte.
ALTER TABLE "agents" ADD COLUMN "voice_name" TEXT;
ALTER TABLE "agents" ADD COLUMN "speaking_style" TEXT;
