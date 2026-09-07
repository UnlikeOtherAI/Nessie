CREATE TABLE "task_checklists" (
  "id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "source_template_id" UUID NOT NULL,
  "source_template_version" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "task_checklists_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_checklists_task_id_key" ON "task_checklists"("task_id");
CREATE INDEX "task_checklists_organization_id_idx" ON "task_checklists"("organization_id");
CREATE INDEX "task_checklists_source_template_id_idx" ON "task_checklists"("source_template_id");

ALTER TABLE "task_checklists" ADD CONSTRAINT "task_checklists_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_checklists" ADD CONSTRAINT "task_checklists_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_checklists" ADD CONSTRAINT "task_checklists_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "task_checklist_steps" (
  "id" UUID NOT NULL,
  "checklist_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "instructions" TEXT NOT NULL,
  "completed_at" TIMESTAMP(3),
  "result" TEXT,
  CONSTRAINT "task_checklist_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_checklist_steps_checklist_id_sequence_key" ON "task_checklist_steps"("checklist_id", "sequence");
CREATE UNIQUE INDEX "task_checklist_steps_checklist_id_key_key" ON "task_checklist_steps"("checklist_id", "key");
CREATE INDEX "task_checklist_steps_checklist_id_idx" ON "task_checklist_steps"("checklist_id");
ALTER TABLE "task_checklist_steps" ADD CONSTRAINT "task_checklist_steps_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "task_checklists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
