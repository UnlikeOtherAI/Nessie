-- Replace the enforced boolean with a graduated mode (off / warn / enforce) plus a
-- warn threshold and a human-exemption toggle, so enforcement can throttle
-- automations without blocking people.
CREATE TYPE "BudgetMode" AS ENUM ('off', 'warn', 'enforce');

ALTER TABLE "organization_budgets"
  ADD COLUMN "mode" "BudgetMode" NOT NULL DEFAULT 'off';
ALTER TABLE "organization_budgets"
  ADD COLUMN "warn_threshold_percent" INTEGER NOT NULL DEFAULT 80;
ALTER TABLE "organization_budgets"
  ADD COLUMN "block_humans_when_over" BOOLEAN NOT NULL DEFAULT false;

-- Preserve existing behaviour: any row that was enforcing keeps enforcing.
UPDATE "organization_budgets" SET "mode" = 'enforce' WHERE "enforced" = true;

ALTER TABLE "organization_budgets" DROP COLUMN "enforced";
