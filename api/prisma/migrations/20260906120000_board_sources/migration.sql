-- External board sources: Jira, Linear, Trello and GitHub feeding a project's
-- boards. Items are mirrored into ordinary tasks plus a link row, so agents,
-- approvals, search and the personal assistant's ticket tools work on them
-- unchanged.

CREATE TYPE "BoardSourceProvider" AS ENUM ('jira', 'linear', 'trello', 'github');
CREATE TYPE "BoardSourceConnectionStatus" AS ENUM ('active', 'needs_reauthorization', 'revoked');
CREATE TYPE "BoardSourceWriteMode" AS ENUM ('read_only', 'read_write');
CREATE TYPE "BoardSourceHealth" AS ENUM (
    'active', 'paused', 'needs_reauthorization', 'owner_inactive', 'misconfigured', 'error'
);

ALTER TYPE "UserAlertKind" ADD VALUE 'board_source_health';

CREATE TABLE "board_source_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "provider" "BoardSourceProvider" NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "external_tenant_id" TEXT NOT NULL DEFAULT '',
    "status" "BoardSourceConnectionStatus" NOT NULL DEFAULT 'active',
    "granted_scopes" JSONB NOT NULL DEFAULT '[]',
    "last_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_source_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "board_source_connections_organization_id_owner_user_id_prov_key" ON "board_source_connections"(
    "organization_id", "owner_user_id", "provider", "external_account_id", "external_tenant_id"
);
CREATE INDEX "board_source_connections_organization_id_owner_user_id_idx"
    ON "board_source_connections"("organization_id", "owner_user_id");

ALTER TABLE "board_source_connections" ADD CONSTRAINT "board_source_connections_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_source_connections" ADD CONSTRAINT "board_source_connections_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "board_source_connection_credentials" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "access_token_ciphertext" TEXT NOT NULL,
    "refresh_token_ciphertext" TEXT,
    "expires_at" TIMESTAMP(3),
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_source_connection_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "board_source_connection_credentials_connection_id_key"
    ON "board_source_connection_credentials"("connection_id");
ALTER TABLE "board_source_connection_credentials"
    ADD CONSTRAINT "board_source_connection_credentials_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "board_source_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "board_source_oauth_states" (
    "token" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "BoardSourceProvider" NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_source_oauth_states_pkey" PRIMARY KEY ("token")
);
CREATE INDEX "board_source_oauth_states_expires_at_idx" ON "board_source_oauth_states"("expires_at");

CREATE TABLE "board_sources" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" "BoardSourceProvider" NOT NULL,
    "name" TEXT NOT NULL,
    "container" JSONB NOT NULL,
    "container_key" TEXT NOT NULL,
    "write_mode" "BoardSourceWriteMode" NOT NULL DEFAULT 'read_only',
    "state_mapping" JSONB NOT NULL DEFAULT '[]',
    "field_mappings" JSONB NOT NULL DEFAULT '[]',
    "sync_window_days" INTEGER NOT NULL DEFAULT 30,
    "health_state" "BoardSourceHealth" NOT NULL DEFAULT 'active',
    "health_reason" TEXT,
    "health_detail" TEXT,
    "health_revision" INTEGER NOT NULL DEFAULT 0,
    "last_sync_started_at" TIMESTAMP(3),
    "last_sync_completed_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "checkpoint" JSONB NOT NULL DEFAULT '{}',
    "webhook_external_id" TEXT,
    "webhook_expires_at" TIMESTAMP(3),
    "webhook_token_hash" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "board_sources_project_id_provider_container_key_key"
    ON "board_sources"("project_id", "provider", "container_key");
CREATE INDEX "board_sources_next_run_at_claimed_at_idx" ON "board_sources"("next_run_at", "claimed_at");
CREATE INDEX "board_sources_organization_id_health_state_idx" ON "board_sources"("organization_id", "health_state");
CREATE INDEX "board_sources_connection_id_idx" ON "board_sources"("connection_id");

ALTER TABLE "board_sources" ADD CONSTRAINT "board_sources_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_sources" ADD CONSTRAINT "board_sources_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT: removing a connection that sources still run under is refused, so a
-- project's board never silently stops updating.
ALTER TABLE "board_sources" ADD CONSTRAINT "board_sources_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "board_source_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "task_external_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "external_key" TEXT NOT NULL,
    "external_url" TEXT NOT NULL,
    "remote_state_id" TEXT,
    "remote_state_name" TEXT,
    "remote_assignee_external_id" TEXT,
    "remote_assignee_display" TEXT,
    "external_updated_at" TIMESTAMP(3),
    "remote_deleted_at" TIMESTAMP(3),
    "inbound_fingerprint" TEXT,
    "outbound_fingerprint" TEXT,
    "last_inbound_at" TIMESTAMP(3),
    "last_outbound_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_external_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_external_links_task_id_key" ON "task_external_links"("task_id");
CREATE UNIQUE INDEX "task_external_links_source_id_external_id_key"
    ON "task_external_links"("source_id", "external_id");
CREATE INDEX "task_external_links_organization_id_idx" ON "task_external_links"("organization_id");

ALTER TABLE "task_external_links" ADD CONSTRAINT "task_external_links_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_external_links" ADD CONSTRAINT "task_external_links_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "board_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "board_source_identity_links" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "provider" "BoardSourceProvider" NOT NULL,
    "external_tenant_key" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "external_display_name" TEXT,
    "user_id" UUID,
    "agent_id" UUID,
    "matched_by" TEXT NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_source_identity_links_pkey" PRIMARY KEY ("id"),
    -- A provider identity resolves to a person, or to an agent, or to neither
    -- (seen and left unmapped) — never to both.
    CONSTRAINT "board_source_identity_links_one_target"
        CHECK (NOT ("user_id" IS NOT NULL AND "agent_id" IS NOT NULL))
);

CREATE UNIQUE INDEX "board_source_identity_links_organization_id_provider_extern_key" ON "board_source_identity_links"(
    "organization_id", "provider", "external_tenant_key", "external_user_id"
);
CREATE INDEX "board_source_identity_links_organization_id_user_id_idx"
    ON "board_source_identity_links"("organization_id", "user_id");

ALTER TABLE "board_source_identity_links" ADD CONSTRAINT "board_source_identity_links_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_source_identity_links" ADD CONSTRAINT "board_source_identity_links_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_source_identity_links" ADD CONSTRAINT "board_source_identity_links_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_alerts" ADD COLUMN "board_source_id" UUID;
CREATE INDEX "user_alerts_board_source_id_idx" ON "user_alerts"("board_source_id");
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_board_source_id_fkey"
    FOREIGN KEY ("board_source_id") REFERENCES "board_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
