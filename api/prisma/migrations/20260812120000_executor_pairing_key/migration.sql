-- Pending pairing records have no machine key. The public half moves to the
-- executor only after a human confirms the pending enrollment fingerprint.
ALTER TABLE "executors"
  ADD COLUMN "machine_public_key" TEXT,
  ALTER COLUMN "machine_key_fingerprint" DROP NOT NULL;

CREATE UNIQUE INDEX "executors_machine_key_fingerprint_key"
  ON "executors"("machine_key_fingerprint");
