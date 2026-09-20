ALTER TABLE "local_inference_frames"
  ADD COLUMN "acknowledged_at" TIMESTAMP(3);

ALTER TABLE "local_inference_attempts"
  ADD COLUMN "model_digest" TEXT;

UPDATE "local_inference_attempts"
  SET "model_digest" = "request_digest"
  WHERE "model_digest" IS NULL;

ALTER TABLE "local_inference_attempts"
  ALTER COLUMN "model_digest" SET NOT NULL;

DROP INDEX "local_inference_frames_attempt_created_idx";
CREATE INDEX "local_inference_frames_attempt_acknowledged_sequence_idx"
  ON "local_inference_frames"("attempt_id", "acknowledged_at", "sequence");

ALTER TABLE "local_inference_host_sequences"
  DROP CONSTRAINT "local_inference_host_sequences_purpose_chk",
  ADD CONSTRAINT "local_inference_host_sequences_purpose_chk" CHECK (
    "purpose" IN ('claim', 'heartbeat', 'poll', 'control', 'frames', 'result', 'goodbye')
  );
