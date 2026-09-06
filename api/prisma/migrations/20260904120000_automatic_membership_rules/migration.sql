-- Automatic team access after sign-in, by DNS-verified email domain.
-- Plan: docs/plans/2026-09-04-automatic-team-membership-by-verified-domain.md
--
-- Purely additive: three new tables and one enum. Nothing existing changes
-- shape, no data is backfilled, and no rule is inferred or activated by this
-- migration — a domain claim only ever exists because an administrator made
-- one and proved DNS control of it.

CREATE TYPE "AutomaticMembershipDomainStatus" AS ENUM (
  'pending', 'verified', 'active', 'suspended', 'revoked'
);

CREATE TABLE "automatic_membership_domains" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "domain" TEXT NOT NULL,
  "status" "AutomaticMembershipDomainStatus" NOT NULL DEFAULT 'pending',
  "challenge" TEXT NOT NULL,
  "challenge_issued_at" TIMESTAMP(3) NOT NULL,
  "challenge_expires_at" TIMESTAMP(3) NOT NULL,
  "first_seen_at" TIMESTAMP(3),
  "verified_at" TIMESTAMP(3),
  "last_checked_at" TIMESTAMP(3),
  "last_check_outcome" TEXT,
  "last_check_detail" TEXT,
  "revalidation_failures" INTEGER NOT NULL DEFAULT 0,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automatic_membership_domains_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automatic_membership_domains_organization_id_idx"
  ON "automatic_membership_domains" ("organization_id");

-- The revalidation sweep's due-query: a short tick asks "is one due?" rather
-- than relying on a long setInterval that a redeploy would skip.
CREATE INDEX "automatic_membership_domains_status_last_checked_at_idx"
  ON "automatic_membership_domains" ("status", "last_checked_at");

-- Instance-wide exclusivity. A LIVE claim on a domain belongs to exactly one
-- organisation, so a second organisation must use manual invitations until the
-- first releases it. `pending` is outside the predicate so two organisations
-- may both attempt a claim and the first to prove DNS wins; `revoked` is
-- outside it so releasing a domain frees it — including for the organisation
-- that released it, which a plain unique constraint would have blocked
-- forever.
CREATE UNIQUE INDEX "automatic_membership_domains_live_claim_key"
  ON "automatic_membership_domains" ("domain")
  WHERE "status" IN ('verified', 'active', 'suspended');

-- One live claim per organisation per domain: an organisation cannot stack a
-- second pending claim on a domain it is already working on.
CREATE UNIQUE INDEX "automatic_membership_domains_org_live_claim_key"
  ON "automatic_membership_domains" ("organization_id", "domain")
  WHERE "status" IN ('pending', 'verified', 'active', 'suspended');

CREATE TABLE "automatic_membership_rules" (
  "id" UUID NOT NULL,
  "domain_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "created_scope" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "authorized_by_uoa_sub" TEXT NOT NULL,
  "authorized_token_version" INTEGER NOT NULL,
  "authorized_team_id" TEXT NOT NULL,
  "authorized_at" TIMESTAMP(3) NOT NULL,
  "health_state" TEXT NOT NULL DEFAULT 'ok',
  "health_reason" TEXT,
  "health_revision" INTEGER NOT NULL DEFAULT 0,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automatic_membership_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "automatic_membership_rules_domain_id_team_id_key"
  ON "automatic_membership_rules" ("domain_id", "team_id");

CREATE INDEX "automatic_membership_rules_team_id_idx"
  ON "automatic_membership_rules" ("team_id");

-- The idempotency ledger. The unique pair is what makes a retry, a duplicate
-- sign-in event, an overlapping rule and two concurrent logins all resolve to
-- one upstream call.
CREATE TABLE "automatic_membership_grants" (
  "id" UUID NOT NULL,
  "rule_id" UUID NOT NULL,
  "uoa_sub" TEXT NOT NULL,
  "outcome" TEXT NOT NULL DEFAULT 'attempted',
  "source" TEXT NOT NULL,
  "lease_expires_at" TIMESTAMP(3),
  "failure_reason" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automatic_membership_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "automatic_membership_grants_rule_id_uoa_sub_key"
  ON "automatic_membership_grants" ("rule_id", "uoa_sub");

CREATE INDEX "automatic_membership_grants_rule_id_outcome_idx"
  ON "automatic_membership_grants" ("rule_id", "outcome");

CREATE TABLE "automatic_membership_reconciliations" (
  "id" UUID NOT NULL,
  "domain_id" UUID NOT NULL,
  "rule_ids" TEXT[],
  "status" TEXT NOT NULL DEFAULT 'queued',
  "cursor" TEXT,
  "scanned" INTEGER NOT NULL DEFAULT 0,
  "matched" INTEGER NOT NULL DEFAULT 0,
  "granted" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "authorized_by_uoa_sub" TEXT NOT NULL,
  "authorized_token_version" INTEGER NOT NULL,
  "authorized_team_id" TEXT NOT NULL,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "requested_by_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automatic_membership_reconciliations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "automatic_membership_reconciliations_domain_id_status_idx"
  ON "automatic_membership_reconciliations" ("domain_id", "status");

ALTER TABLE "automatic_membership_domains"
  ADD CONSTRAINT "automatic_membership_domains_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automatic_membership_rules"
  ADD CONSTRAINT "automatic_membership_rules_domain_id_fkey"
  FOREIGN KEY ("domain_id") REFERENCES "automatic_membership_domains"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automatic_membership_rules"
  ADD CONSTRAINT "automatic_membership_rules_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automatic_membership_grants"
  ADD CONSTRAINT "automatic_membership_grants_rule_id_fkey"
  FOREIGN KEY ("rule_id") REFERENCES "automatic_membership_rules"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automatic_membership_reconciliations"
  ADD CONSTRAINT "automatic_membership_reconciliations_domain_id_fkey"
  FOREIGN KEY ("domain_id") REFERENCES "automatic_membership_domains"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
