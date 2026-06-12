-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "assignee_agent_id" UUID;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_agent_id_fkey" FOREIGN KEY ("assignee_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "tasks_assignee_agent_id_status_idx" ON "tasks"("assignee_agent_id", "status");
