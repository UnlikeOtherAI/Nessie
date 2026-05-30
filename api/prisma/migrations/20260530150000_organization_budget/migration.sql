-- Per-organization monthly spend cap for LLM usage enforcement.
CREATE TABLE "organization_budgets" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "monthly_cost_limit_usd" DOUBLE PRECISION,
  "enforced" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "organization_budgets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_budgets_organization_id_key"
  ON "organization_budgets"("organization_id");

ALTER TABLE "organization_budgets"
  ADD CONSTRAINT "organization_budgets_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
