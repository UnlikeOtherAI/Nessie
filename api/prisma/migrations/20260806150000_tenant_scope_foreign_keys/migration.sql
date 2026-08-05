-- Tenant + scope referential integrity.
--
-- 40 child tables carried `organization_id` as a bare scalar and the knowledge
-- tables carried a required `project_id`, both with no foreign key. That is the
-- structural gap underneath the application-level tenancy checks: nothing at the
-- database level stopped a row being written with another tenant's id, nothing
-- cleaned those rows up when an organization or project was deleted, and a
-- dangling id was indistinguishable from a real one.
--
-- Each ADD CONSTRAINT is preceded by a guarded sweep of rows whose parent no
-- longer exists. Those rows are already unreachable — their organization or
-- project is gone — and without the sweep the ADD CONSTRAINT fails and blocks
-- the deploy. On clean data every DELETE is a no-op.
--
-- ON DELETE CASCADE matches the relations declared in schema.prisma, so
-- deleting an organization now removes its dependent rows in one statement
-- instead of leaving them orphaned.

DELETE FROM "board_columns" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "iterations" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "iterations" ADD CONSTRAINT "iterations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "realtime_events" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "realtime_events" ADD CONSTRAINT "realtime_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "user_presence" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "agents" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "run_checkpoints" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "run_checkpoints" ADD CONSTRAINT "run_checkpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "agent_mailbox_messages" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "agent_mailbox_messages" ADD CONSTRAINT "agent_mailbox_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "workflow_templates" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "workflow_installations" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "workflow_installations" ADD CONSTRAINT "workflow_installations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "workflow_state_entries" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "workflow_state_entries" ADD CONSTRAINT "workflow_state_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "workflow_runs" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "execution_environment_templates" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "execution_environment_templates" ADD CONSTRAINT "execution_environment_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "execution_environment_instances" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "execution_environment_instances" ADD CONSTRAINT "execution_environment_instances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "execution_runners" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "execution_runners" ADD CONSTRAINT "execution_runners_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "execution_usage_ledger" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "execution_usage_ledger" ADD CONSTRAINT "execution_usage_ledger_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "tool_registry_entries" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "tool_registry_entries" ADD CONSTRAINT "tool_registry_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "mcp_server_instances" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "mcp_server_instances" ADD CONSTRAINT "mcp_server_instances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "tool_bundles" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "tool_bundles" ADD CONSTRAINT "tool_bundles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "temporary_context_sessions" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "temporary_context_sessions" ADD CONSTRAINT "temporary_context_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "policy_rules" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "audit_logs" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "token_ledger_events" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "token_ledger_events" ADD CONSTRAINT "token_ledger_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "budget_alerts" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "model_pricing_profiles" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "model_pricing_profiles" ADD CONSTRAINT "model_pricing_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "connector_usage_events" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "connector_usage_events" ADD CONSTRAINT "connector_usage_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "storage_usage_events" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "storage_usage_events" ADD CONSTRAINT "storage_usage_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "knowledge_space_members" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "knowledge_space_members" ADD CONSTRAINT "knowledge_space_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "knowledge_page_links" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "knowledge_page_links" ADD CONSTRAINT "knowledge_page_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "page_labels" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "page_labels" ADD CONSTRAINT "page_labels_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "knowledge_page_annotations" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "knowledge_page_annotations" ADD CONSTRAINT "knowledge_page_annotations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "knowledge_page_annotation_reactions" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "knowledge_page_annotation_reactions" ADD CONSTRAINT "knowledge_page_annotation_reactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "thought_reasonings" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "thought_reasonings" ADD CONSTRAINT "thought_reasonings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "attachments" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "device_tokens" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "web_push_subscriptions" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "web_push_subscriptions" ADD CONSTRAINT "web_push_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "push_deliveries" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "comms_connections" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "comms_connections" ADD CONSTRAINT "comms_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "comms_oauth_states" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "comms_oauth_states" ADD CONSTRAINT "comms_oauth_states_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "comms_events" WHERE "organization_id" IS NOT NULL AND "organization_id" NOT IN (SELECT "id" FROM "organizations");
ALTER TABLE "comms_events" ADD CONSTRAINT "comms_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Knowledge-base scope: project_id is required on these tables but had no FK.

DELETE FROM "knowledge_spaces" WHERE "project_id" NOT IN (SELECT "id" FROM "projects");
ALTER TABLE "knowledge_spaces" ADD CONSTRAINT "knowledge_spaces_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "knowledge_pages" WHERE "project_id" NOT IN (SELECT "id" FROM "projects");
ALTER TABLE "knowledge_pages" ADD CONSTRAINT "knowledge_pages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DELETE FROM "knowledge_page_chunks" WHERE "project_id" NOT IN (SELECT "id" FROM "projects");
ALTER TABLE "knowledge_page_chunks" ADD CONSTRAINT "knowledge_page_chunks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
