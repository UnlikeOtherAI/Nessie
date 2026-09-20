-- Additive replay fence for the signed host protocol.  Old writers never
-- depend on this table; new signed routes fail closed until it exists.
CREATE TABLE "local_inference_host_sequences" (
  "host_id" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "last_sequence" BIGINT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "local_inference_host_sequences_pkey" PRIMARY KEY ("host_id", "purpose"),
  CONSTRAINT "local_inference_host_sequences_purpose_chk" CHECK (
    "purpose" IN ('claim', 'heartbeat', 'poll', 'frames', 'goodbye')
  ),
  CONSTRAINT "local_inference_host_sequences_sequence_chk" CHECK ("last_sequence" > 0),
  CONSTRAINT "local_inference_host_sequences_host_fkey"
    FOREIGN KEY ("host_id") REFERENCES "local_inference_hosts"("id") ON DELETE CASCADE
);
