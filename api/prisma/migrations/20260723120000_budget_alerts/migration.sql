-- CreateTable
CREATE TABLE "budget_alerts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scope_type" "BudgetScopeType" NOT NULL,
    "scope_id" UUID NOT NULL,
    "period" "BudgetPeriod" NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "kind" TEXT NOT NULL,
    "percent_used" INTEGER,
    "spent_usd" DECIMAL(14,4),
    "cost_limit_usd" DECIMAL(14,4),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "budget_alerts_scope_type_scope_id_period_start_kind_key" ON "budget_alerts"("scope_type", "scope_id", "period_start", "kind");

-- CreateIndex
CREATE INDEX "budget_alerts_organization_id_created_at_idx" ON "budget_alerts"("organization_id", "created_at");
