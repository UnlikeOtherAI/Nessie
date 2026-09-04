-- A domain is owned by exactly one organisation until an explicit release.
-- Pending challenges therefore cannot be used to race a later verified claim.
CREATE UNIQUE INDEX "automatic_membership_open_domain_claim_unique"
  ON "automatic_membership_domain_claims" ("domain_ascii")
  WHERE "released_at" IS NULL;
