-- The bell kind a person-to-person share will raise.
--
-- The value lands before anything writes it, on purpose. `UserAlertKind` is a
-- database enum and the realtime `alert.created` payload carries the same
-- string, so a replica running the previous build cannot parse a kind it does
-- not know and would crash on it during a blue-green swap. The reader side
-- (this value, the zod enums, the bell's rendering) ships one deploy ahead of
-- the writer, which Wave 2A enables.
ALTER TYPE "UserAlertKind" ADD VALUE IF NOT EXISTS 'knowledge_shared';
