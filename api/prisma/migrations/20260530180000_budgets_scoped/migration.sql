-- Generalize the single per-org budget into scoped budgets (organization / project
-- / team) with a configurable period and an explicit "unlimited" override.
-- Resolution is most-specific-first, so a project/team budget overrides the org
-- budget, and an "unlimited" scope is exempt rather than inheriting a parent cap.

CREATE TYPE "BudgetScopeType" AS ENUM ('organization', 'project', 'team');
CREATE TYPE "BudgetPeriod" AS ENUM ('weekly', 'monthly', 'yearly');

-- Add the 'unlimited' mode by recreating the enum (avoids the in-transaction
-- restriction on using a freshly ALTER-TYPE-added enum value).
ALTER TYPE "BudgetMode" RENAME TO "BudgetMode_old";
CREATE TYPE "BudgetMode" AS ENUM ('off', 'warn', 'enforce', 'unlimited');

CREATE TABLE "budgets" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "scope_type" "BudgetScopeType" NOT NULL,
  "scope_id" UUID NOT NULL,
  "cost_limit_usd" DECIMAL(14, 4),
  "token_limit" INTEGER,
  "mode" "BudgetMode" NOT NULL DEFAULT 'off',
  "period" "BudgetPeriod" NOT NULL DEFAULT 'monthly',
  "warn_threshold_percent" INTEGER NOT NULL DEFAULT 80,
  "block_humans_when_over" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- Carry any existing org-wide budget over as an 'organization'-scope monthly budget.
INSERT INTO "budgets" (
  "id", "organization_id", "scope_type", "scope_id", "cost_limit_usd", "token_limit",
  "mode", "period", "warn_threshold_percent", "block_humans_when_over",
  "created_at", "updated_at"
)
SELECT
  "id", "organization_id", 'organization', "organization_id",
  "monthly_cost_limit_usd", "monthly_token_limit",
  "mode"::text::"BudgetMode", 'monthly',
  "warn_threshold_percent", "block_humans_when_over", "created_at", "updated_at"
FROM "organization_budgets";

CREATE UNIQUE INDEX "budgets_scope_type_scope_id_key" ON "budgets"("scope_type", "scope_id");
CREATE INDEX "budgets_organization_id_idx" ON "budgets"("organization_id");
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE "organization_budgets";
DROP TYPE "BudgetMode_old";
