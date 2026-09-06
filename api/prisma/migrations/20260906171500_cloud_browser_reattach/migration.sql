-- Cloud-browser re-attach (horizontal scaling, audit 8.1).
--
-- The CDP connect URL and the cross-origin write gate lived only in the worker
-- process that ran `browser_open`. A run that suspends for the cross-origin
-- approval is re-enqueued and claimed by any worker, where the pool has no
-- entry for the session: the run could not drive it, could not reopen it
-- (`SESSION_ALREADY_OPEN`), and the remote browser billed until its TTL.
--
-- The connect URL is a live-session bearer capability, so it is stored sealed
-- with the deployment auth secret (the same AES-256-GCM packing executor
-- command payloads use) and cleared the moment the row leaves `active`.
ALTER TABLE "cloud_browser_sessions"
  ADD COLUMN "connect_capability_ciphertext" TEXT,
  ADD COLUMN "origin_gate" JSONB;
