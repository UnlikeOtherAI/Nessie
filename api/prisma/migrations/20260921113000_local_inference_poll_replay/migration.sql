ALTER TABLE "local_inference_attempts" ADD COLUMN "poll_request_id" UUID;
CREATE UNIQUE INDEX "local_inference_attempts_poll_request_id_key"
  ON "local_inference_attempts"("poll_request_id");
