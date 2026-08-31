-- A learned routine remains an ordinary WorkflowTemplate. These fields retain
-- its structural trace and make agent-proposed adoption a durable decision.

CREATE TYPE "WorkflowTemplateSource" AS ENUM ('authored', 'demonstration');

ALTER TABLE "workflow_templates"
  ADD COLUMN "source" "WorkflowTemplateSource" NOT NULL DEFAULT 'authored',
  ADD COLUMN "demonstration_id" UUID,
  ADD COLUMN "adopted_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "workflow_templates_demonstration_id_key"
  ON "workflow_templates"("demonstration_id")
  WHERE "demonstration_id" IS NOT NULL;

ALTER TABLE "workflow_templates"
  ADD CONSTRAINT "workflow_templates_demonstration_id_fkey"
    FOREIGN KEY ("demonstration_id") REFERENCES "demonstrations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
