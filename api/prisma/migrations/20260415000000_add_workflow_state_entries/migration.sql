-- CreateTable
CREATE TABLE "workflow_state_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "workflow_installation_id" UUID NOT NULL,
    "workflow_run_id" UUID,
    "workflow_step_run_id" UUID,
    "state_key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "value_hash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_state_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_state_entries_workflow_installation_id_key_key" ON "workflow_state_entries"("workflow_installation_id", "state_key");

-- CreateIndex
CREATE INDEX "workflow_state_entries_organization_id_updated_at_idx" ON "workflow_state_entries"("organization_id", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "workflow_state_entries_workflow_installation_id_updated_at_idx" ON "workflow_state_entries"("workflow_installation_id", "updated_at" DESC);

-- AddForeignKey
ALTER TABLE "workflow_state_entries" ADD CONSTRAINT "workflow_state_entries_workflow_installation_id_fkey" FOREIGN KEY ("workflow_installation_id") REFERENCES "workflow_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_state_entries" ADD CONSTRAINT "workflow_state_entries_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_state_entries" ADD CONSTRAINT "workflow_state_entries_workflow_step_run_id_fkey" FOREIGN KEY ("workflow_step_run_id") REFERENCES "workflow_step_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
