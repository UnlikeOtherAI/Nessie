-- Judged delegation: the assistant decides within a boundary the owner wrote,
-- and asks when it is unsure.
--
-- No "deny" outcome exists by design — the assistant never silently refuses on
-- somebody's behalf, so anything outside the boundary becomes a question. The
-- boundary is free text because it is judged by a model: a rule builder with
-- keyword fields could not honour a boundary written in one language about
-- mail written in another.

CREATE TYPE "SendAuthorizationMode" AS ENUM ('always', 'judged');

ALTER TABLE "send_authorization_grants"
  ADD COLUMN "mode" "SendAuthorizationMode" NOT NULL DEFAULT 'always',
  ADD COLUMN "boundary" TEXT,
  ADD COLUMN "decided_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "asked_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_decided_at" TIMESTAMP(3);
