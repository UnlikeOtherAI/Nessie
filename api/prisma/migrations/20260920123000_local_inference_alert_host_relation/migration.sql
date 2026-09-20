-- Local-inference health is recipient-private. The relation lets the shared
-- alert reader prove that the current caller remains this host's custodian,
-- and cascades a discarded host's stale bell rows.
ALTER TABLE "user_alerts"
  ADD CONSTRAINT "user_alerts_local_inference_host_id_fkey"
  FOREIGN KEY ("local_inference_host_id") REFERENCES "local_inference_hosts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
