-- Agent triggers can now target either an agent or a workflow installation.
-- Exactly one of agent_id or workflow_installation_id must be set.

ALTER TABLE "agent_triggers"
    ALTER COLUMN "agent_id" DROP NOT NULL,
    ADD COLUMN "workflow_installation_id" UUID;

ALTER TABLE "agent_triggers"
    ADD CONSTRAINT "agent_triggers_workflow_installation_id_fkey"
        FOREIGN KEY ("workflow_installation_id")
        REFERENCES "workflow_installations"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_triggers"
    ADD CONSTRAINT "agent_triggers_target_exclusive"
        CHECK (
            ("agent_id" IS NOT NULL AND "workflow_installation_id" IS NULL)
            OR ("agent_id" IS NULL AND "workflow_installation_id" IS NOT NULL)
        );

CREATE INDEX "agent_triggers_workflow_installation_id_created_at_idx"
    ON "agent_triggers"("workflow_installation_id", "created_at");
CREATE INDEX "agent_triggers_workflow_installation_id_enabled_status_idx"
    ON "agent_triggers"("workflow_installation_id", "enabled", "status");
