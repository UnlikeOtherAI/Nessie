-- Harden the initial additive rollout without rewriting its committed history.
-- Pending challenges do not reserve a domain: only an actually verified claim
-- is exclusive. This prevents a hostile pending row from squatting a domain.
DROP INDEX IF EXISTS "automatic_membership_active_domain_claim_unique";
CREATE UNIQUE INDEX "automatic_membership_open_claim_per_org_domain"
  ON "automatic_membership_domain_claims" ("organization_id", "domain_ascii")
  WHERE "released_at" IS NULL;
CREATE UNIQUE INDEX "automatic_membership_verified_domain_claim_unique"
  ON "automatic_membership_domain_claims" ("domain_ascii")
  WHERE "released_at" IS NULL AND "state" IN ('verified', 'suspended', 'challenge_rotation');

-- A worker owns a run through one conditional fence. The old lease history is
-- retained for audit compatibility; it is not used as an authority anymore.
ALTER TABLE "automatic_membership_backfill_runs"
  ADD COLUMN "lease_token" text,
  ADD COLUMN "lease_expires_at" timestamp(3),
  ADD COLUMN "lease_generation" integer,
  ADD COLUMN "attempt_count" integer NOT NULL DEFAULT 0;
CREATE INDEX "automatic_membership_backfill_runs_lease_idx"
  ON "automatic_membership_backfill_runs" ("lease_expires_at");
ALTER TYPE "AutomaticMembershipBackfillStatus" ADD VALUE IF NOT EXISTS 'completed_with_failures';

CREATE TABLE "automatic_membership_rate_limits" (
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "domain_ascii" text NOT NULL,
  "window_started_at" timestamp(3) NOT NULL,
  "used" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("organization_id", "domain_ascii")
);

-- Never infer the UOA hierarchy from Team.projectId. A target must be bound to
-- the rule organisation's exact UOA organisation and have an external team id.
CREATE OR REPLACE FUNCTION automatic_membership_target_same_organization() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "automatic_membership_rules" r
    JOIN "organizations" o ON o."id" = r."organization_id"
    JOIN "teams" t ON t."id" = NEW."team_id"
    WHERE r."id" = NEW."rule_id"
      AND o."external_org_id" IS NOT NULL
      AND t."external_org_id" = o."external_org_id"
      AND t."external_team_id" IS NOT NULL
  ) THEN RAISE EXCEPTION 'automatic membership target must be bound to rule UOA organization'; END IF;
  IF EXISTS (
    SELECT 1
    FROM "automatic_membership_rule_targets" existing
    JOIN "automatic_membership_rules" existing_rule ON existing_rule."id" = existing."rule_id"
    JOIN "automatic_membership_rules" next_rule ON next_rule."id" = NEW."rule_id"
    WHERE existing_rule."claim_id" = next_rule."claim_id"
      AND existing."team_id" = NEW."team_id"
      AND existing_rule."scope" = 'team'
      AND existing_rule."state" <> 'revoked'
      AND existing."rule_id" <> NEW."rule_id"
  ) THEN RAISE EXCEPTION 'a domain can have one non-revoked team rule per team'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
