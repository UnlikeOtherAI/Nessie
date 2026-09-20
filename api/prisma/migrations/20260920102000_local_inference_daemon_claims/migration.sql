-- A host claim is not an agent-binding consent.  Keeping its one-use digest in
-- the same bounded challenge store gives both flows the same replay/TTL rules
-- without fabricating an inactive binding merely to satisfy a foreign key.
ALTER TABLE "local_inference_challenges"
  ALTER COLUMN "binding_id" DROP NOT NULL,
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'binding',
  ADD COLUMN "connection_epoch" INTEGER;

ALTER TABLE "local_inference_challenges"
  ADD CONSTRAINT "local_inference_challenges_purpose_chk"
  CHECK (
    ("purpose" = 'binding' AND "binding_id" IS NOT NULL AND "connection_epoch" IS NULL)
    OR ("purpose" = 'daemon' AND "binding_id" IS NULL AND "connection_epoch" IS NOT NULL)
  );

ALTER TABLE "local_inference_host_sequences"
  DROP CONSTRAINT "local_inference_host_sequences_purpose_chk",
  ADD CONSTRAINT "local_inference_host_sequences_purpose_chk" CHECK (
    "purpose" IN ('claim', 'heartbeat', 'poll', 'frames', 'result', 'goodbye')
  );
