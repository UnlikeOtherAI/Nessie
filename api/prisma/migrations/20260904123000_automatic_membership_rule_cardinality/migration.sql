-- Follow-up only: the prior additive migration is immutable once committed.
ALTER TABLE "automatic_membership_rules"
  DROP CONSTRAINT IF EXISTS "automatic_membership_rules_claim_scope_key";
CREATE UNIQUE INDEX "automatic_membership_one_org_rule_per_claim"
  ON "automatic_membership_rules" ("claim_id")
  WHERE "scope" = 'organization' AND "state" <> 'revoked';
