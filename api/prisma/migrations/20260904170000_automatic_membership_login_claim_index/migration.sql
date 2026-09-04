-- The interactive path evaluates only live claims and never scans identity
-- data. This supports its bounded verified-claim lookup as claim volume grows.
CREATE INDEX "automatic_membership_domain_claims_live_lookup_idx"
  ON "automatic_membership_domain_claims" ("state", "verification_expires_at");
