-- Additive, feature-flagged automatic membership. No existing membership is
-- inferred or activated by this migration.
CREATE TYPE "AutomaticMembershipClaimState" AS ENUM ('pending', 'verified', 'suspended', 'revoked', 'challenge_rotation');
CREATE TYPE "AutomaticMembershipRuleState" AS ENUM ('inactive', 'active', 'suspended', 'revoked');
CREATE TYPE "AutomaticMembershipRuleScope" AS ENUM ('organization', 'team');
CREATE TYPE "AutomaticMembershipBackfillStatus" AS ENUM ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'superseded');

CREATE TABLE "automatic_membership_domain_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "domain_ascii" text NOT NULL,
  "state" "AutomaticMembershipClaimState" NOT NULL DEFAULT 'pending',
  "challenge_digest" text NOT NULL,
  "challenge_encrypted" text NOT NULL,
  "challenge_generation" integer NOT NULL DEFAULT 1,
  "notification_email" text,
  "classifier_version" text NOT NULL,
  "verified_at" timestamp(3),
  "verification_expires_at" timestamp(3),
  "last_dns_check_at" timestamp(3),
  "last_dns_failure" text,
  "released_at" timestamp(3),
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "automatic_membership_active_domain_claim_unique"
  ON "automatic_membership_domain_claims" ("domain_ascii") WHERE "released_at" IS NULL;
CREATE INDEX "automatic_membership_domain_claims_organization_state_idx"
  ON "automatic_membership_domain_claims" ("organization_id", "state");

CREATE TABLE "automatic_membership_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "claim_id" uuid NOT NULL REFERENCES "automatic_membership_domain_claims"("id") ON DELETE RESTRICT,
  "scope" "AutomaticMembershipRuleScope" NOT NULL,
  "state" "AutomaticMembershipRuleState" NOT NULL DEFAULT 'inactive',
  "generation" integer NOT NULL DEFAULT 1,
  "suspension_reason" text,
  "created_by_uoa_sub" text NOT NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automatic_membership_rules_claim_scope_key" UNIQUE ("claim_id", "scope")
);
CREATE INDEX "automatic_membership_rules_organization_state_idx"
  ON "automatic_membership_rules" ("organization_id", "state");

CREATE TABLE "automatic_membership_rule_targets" (
  "rule_id" uuid NOT NULL REFERENCES "automatic_membership_rules"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  PRIMARY KEY ("rule_id", "team_id")
);
CREATE INDEX "automatic_membership_rule_targets_team_idx" ON "automatic_membership_rule_targets" ("team_id");

CREATE TABLE "automatic_membership_backfill_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "rule_id" uuid NOT NULL REFERENCES "automatic_membership_rules"("id") ON DELETE CASCADE,
  "generation" integer NOT NULL,
  "status" "AutomaticMembershipBackfillStatus" NOT NULL DEFAULT 'queued',
  "cursor_token" text,
  "snapshot_id" text,
  "attempted_count" integer NOT NULL DEFAULT 0,
  "granted_count" integer NOT NULL DEFAULT 0,
  "failure_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp(3),
  "requested_by_uoa_sub" text NOT NULL,
  "last_error" text,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automatic_membership_backfill_runs_rule_generation_key" UNIQUE ("rule_id", "generation")
);
CREATE INDEX "automatic_membership_backfill_runs_status_next_attempt_idx"
  ON "automatic_membership_backfill_runs" ("status", "next_attempt_at");

CREATE TABLE "automatic_membership_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "rule_id" uuid NOT NULL REFERENCES "automatic_membership_rules"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "uoa_sub" text NOT NULL,
  "generation" integer NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "uoa_operation_id" text,
  "outcome" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automatic_membership_grants_rule_team_subject_generation_key" UNIQUE ("rule_id", "team_id", "uoa_sub", "generation")
);
CREATE INDEX "automatic_membership_grants_organization_outcome_idx"
  ON "automatic_membership_grants" ("organization_id", "outcome");

CREATE TABLE "automatic_membership_grant_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL REFERENCES "automatic_membership_backfill_runs"("id") ON DELETE CASCADE,
  "generation" integer NOT NULL,
  "lease_token" text NOT NULL UNIQUE,
  "expires_at" timestamp(3) NOT NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "automatic_membership_grant_leases_run_expires_idx"
  ON "automatic_membership_grant_leases" ("run_id", "expires_at");

-- A rule target must always be a team in the rule organisation. Prisma cannot
-- express the cross-table predicate, so retain it as a database trigger.
CREATE FUNCTION automatic_membership_target_same_organization() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "automatic_membership_rules" r
    JOIN "teams" t ON t."id" = NEW."team_id"
    JOIN "projects" p ON p."id" = t."project_id"
    WHERE r."id" = NEW."rule_id" AND r."organization_id" = p."organization_id"
  ) THEN RAISE EXCEPTION 'automatic membership target must belong to rule organization'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER automatic_membership_target_same_organization_trigger
  BEFORE INSERT OR UPDATE ON "automatic_membership_rule_targets"
  FOR EACH ROW EXECUTE FUNCTION automatic_membership_target_same_organization();
