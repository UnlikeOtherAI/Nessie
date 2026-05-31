-- Degrade-instead-of-deny: when over cap, route to a cheaper model rather than
-- blocking. Adds the 'degrade' mode and the cheaper-model target columns.
ALTER TYPE "BudgetMode" ADD VALUE IF NOT EXISTS 'degrade' AFTER 'enforce';

ALTER TABLE "budgets" ADD COLUMN "degrade_model" TEXT;
ALTER TABLE "budgets" ADD COLUMN "degrade_provider" TEXT;
