-- Individual Communications Connectors: per-user Slack / Google / Microsoft
-- connections, encrypted credentials, single-use OAuth state, discovered
-- resources, resumable sync jobs, a normalized event store keyed on the
-- deterministic canonical id, and renewable webhook subscriptions.
-- See docs/plans/2026-07-21-individual-communications-connector.md.

-- CreateEnum
CREATE TYPE "CommsProvider" AS ENUM (
  'slack',
  'google',
  'microsoft'
);

CREATE TYPE "CommsConnectionStatus" AS ENUM (
  'active',
  'needs_reauthorization',
  'disconnected',
  'error'
);

CREATE TYPE "CommsSyncPhase" AS ENUM (
  'history',
  'incremental',
  'reconciliation'
);

CREATE TYPE "CommsSyncStatus" AS ENUM (
  'pending',
  'running',
  'completed',
  'failed'
);

CREATE TYPE "CommsSubscriptionStatus" AS ENUM (
  'active',
  'expired',
  'failed'
);

-- CreateTable
CREATE TABLE "comms_connections" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "provider" "CommsProvider" NOT NULL,
  "external_tenant_id" TEXT NOT NULL,
  "external_user_id" TEXT NOT NULL,
  "status" "CommsConnectionStatus" NOT NULL DEFAULT 'active',
  "granted_scopes" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "initial_sync_completed_at" TIMESTAMP(3),
  "last_successful_sync_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "comms_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "comms_connection_credentials" (
  "id" UUID NOT NULL,
  "connection_id" UUID NOT NULL,
  "access_token_ciphertext" TEXT NOT NULL,
  "refresh_token_ciphertext" TEXT,
  "expires_at" TIMESTAMP(3),
  "key_version" INTEGER NOT NULL DEFAULT 1,
  "scope_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "comms_connection_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "comms_oauth_states" (
  "token" TEXT NOT NULL,
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "provider" "CommsProvider" NOT NULL,
  "payload" JSONB NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "comms_oauth_states_pkey" PRIMARY KEY ("token")
);

CREATE TABLE "comms_resources" (
  "id" UUID NOT NULL,
  "connection_id" UUID NOT NULL,
  "resource_type" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "name" TEXT,
  "visibility" TEXT,
  "user_has_access" BOOLEAN NOT NULL DEFAULT true,
  "sync_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "comms_resources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "comms_sync_jobs" (
  "id" UUID NOT NULL,
  "connection_id" UUID NOT NULL,
  "resource_id" UUID,
  "phase" "CommsSyncPhase" NOT NULL,
  "cursor" TEXT,
  "oldest_imported_at" TIMESTAMP(3),
  "newest_imported_at" TIMESTAMP(3),
  "status" "CommsSyncStatus" NOT NULL DEFAULT 'pending',
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "comms_sync_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "comms_events" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "connection_id" UUID NOT NULL,
  "canonical_message_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "is_deleted" BOOLEAN NOT NULL DEFAULT false,
  "edited_at" TIMESTAMP(3),
  "provider" "CommsProvider" NOT NULL,
  "external_tenant_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "thread_id" TEXT,
  "message_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "sender_external_id" TEXT,
  "sender_display_name" TEXT,
  "sender_email" TEXT,
  "participants" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "subject" TEXT,
  "content_text" TEXT,
  "content_html" TEXT,
  "attachments" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "mentions" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "reactions" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "visibility" TEXT NOT NULL,
  "source_url" TEXT,
  "raw_payload_ref" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "comms_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "comms_subscriptions" (
  "id" UUID NOT NULL,
  "connection_id" UUID NOT NULL,
  "resource_id" UUID,
  "provider" "CommsProvider" NOT NULL,
  "external_subscription_id" TEXT NOT NULL,
  "client_state" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "status" "CommsSubscriptionStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "comms_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "comms_connections_organization_id_owner_user_id_provider_ext_key"
  ON "comms_connections"("organization_id", "owner_user_id", "provider", "external_tenant_id", "external_user_id");
CREATE INDEX "comms_connections_organization_id_owner_user_id_idx"
  ON "comms_connections"("organization_id", "owner_user_id");
CREATE INDEX "comms_connections_status_idx"
  ON "comms_connections"("status");

CREATE UNIQUE INDEX "comms_connection_credentials_connection_id_key"
  ON "comms_connection_credentials"("connection_id");

CREATE INDEX "comms_oauth_states_organization_id_user_id_provider_idx"
  ON "comms_oauth_states"("organization_id", "user_id", "provider");
CREATE INDEX "comms_oauth_states_expires_at_idx"
  ON "comms_oauth_states"("expires_at");

CREATE UNIQUE INDEX "comms_resources_connection_id_external_id_key"
  ON "comms_resources"("connection_id", "external_id");
CREATE INDEX "comms_resources_connection_id_sync_enabled_idx"
  ON "comms_resources"("connection_id", "sync_enabled");

CREATE INDEX "comms_sync_jobs_connection_id_status_idx"
  ON "comms_sync_jobs"("connection_id", "status");
CREATE INDEX "comms_sync_jobs_resource_id_idx"
  ON "comms_sync_jobs"("resource_id");

CREATE UNIQUE INDEX "comms_events_connection_id_canonical_message_id_version_key"
  ON "comms_events"("connection_id", "canonical_message_id", "version");
CREATE INDEX "comms_events_organization_id_connection_id_occurred_at_idx"
  ON "comms_events"("organization_id", "connection_id", "occurred_at");
CREATE INDEX "comms_events_connection_id_conversation_id_occurred_at_idx"
  ON "comms_events"("connection_id", "conversation_id", "occurred_at");

CREATE UNIQUE INDEX "comms_subscriptions_connection_id_external_subscription_id_key"
  ON "comms_subscriptions"("connection_id", "external_subscription_id");
CREATE INDEX "comms_subscriptions_status_expires_at_idx"
  ON "comms_subscriptions"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "comms_connection_credentials"
  ADD CONSTRAINT "comms_connection_credentials_connection_id_fkey"
  FOREIGN KEY ("connection_id")
  REFERENCES "comms_connections"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comms_resources"
  ADD CONSTRAINT "comms_resources_connection_id_fkey"
  FOREIGN KEY ("connection_id")
  REFERENCES "comms_connections"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comms_sync_jobs"
  ADD CONSTRAINT "comms_sync_jobs_connection_id_fkey"
  FOREIGN KEY ("connection_id")
  REFERENCES "comms_connections"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comms_sync_jobs"
  ADD CONSTRAINT "comms_sync_jobs_resource_id_fkey"
  FOREIGN KEY ("resource_id")
  REFERENCES "comms_resources"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "comms_events"
  ADD CONSTRAINT "comms_events_connection_id_fkey"
  FOREIGN KEY ("connection_id")
  REFERENCES "comms_connections"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comms_subscriptions"
  ADD CONSTRAINT "comms_subscriptions_connection_id_fkey"
  FOREIGN KEY ("connection_id")
  REFERENCES "comms_connections"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "comms_subscriptions"
  ADD CONSTRAINT "comms_subscriptions_resource_id_fkey"
  FOREIGN KEY ("resource_id")
  REFERENCES "comms_resources"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
