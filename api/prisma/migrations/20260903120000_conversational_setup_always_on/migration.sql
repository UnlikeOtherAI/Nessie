-- Conversational agent setup is no longer an early-access gate: every
-- organisation has it. The column and its owner-only route are gone, so the
-- flag cannot disagree with behaviour by sitting at its `false` default.
ALTER TABLE "organizations" DROP COLUMN IF EXISTS "conversational_setup_enabled";
