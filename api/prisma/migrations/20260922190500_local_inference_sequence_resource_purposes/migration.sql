-- The daemon intake accepts `resource` and `termination` envelopes
-- (api/src/services/local-inference-daemon-intake.ts) but the sequence table's
-- purpose CHECK still stopped at `goodbye`, so every resource heartbeat failed
-- with SQLSTATE 23514 and the API logged a 500 every 20 seconds.
ALTER TABLE "local_inference_host_sequences"
  DROP CONSTRAINT "local_inference_host_sequences_purpose_chk",
  ADD CONSTRAINT "local_inference_host_sequences_purpose_chk" CHECK (
    "purpose" IN ('claim', 'heartbeat', 'poll', 'control', 'frames', 'result', 'goodbye', 'resource', 'termination')
  );
