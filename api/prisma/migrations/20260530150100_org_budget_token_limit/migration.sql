-- Token-volume cap alongside the USD cost cap. Token counts are always recorded
-- (cost requires a pricing profile), so this is the dependable enforcement lever.
ALTER TABLE "organization_budgets" ADD COLUMN "monthly_token_limit" INTEGER;
