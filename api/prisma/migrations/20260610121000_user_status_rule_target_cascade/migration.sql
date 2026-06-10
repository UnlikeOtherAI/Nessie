ALTER TABLE "user_status_rules"
    DROP CONSTRAINT "user_status_rules_channel_id_fkey",
    ADD CONSTRAINT "user_status_rules_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_status_rules"
    DROP CONSTRAINT "user_status_rules_project_id_fkey",
    ADD CONSTRAINT "user_status_rules_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
