-- Where an agent watcher is woken, and whose authority the run carries.
--
-- Both are resolved when the watcher is added and stored, rather than worked
-- out at wake time. The DM key includes a team, and only the session that added
-- the watcher knows which team that is; a worker recomputing it opened a second
-- DM nobody was reading. The identity is the same problem a trigger solves with
-- `launch_origin`: a wake has no session, so without a captured one the Ledger
-- signer has nothing to verify.
--
-- Null on user rows, and on agent rows written before this migration — the
-- wake reports those as unreachable rather than guessing.
ALTER TABLE "board_watchers"
  ADD COLUMN "channel_id" UUID,
  ADD COLUMN "thread_id" UUID,
  ADD COLUMN "launch_origin" JSONB;
