-- Durable lifecycle for an app connection proposed in a conversation. The card
-- message is only a pointer to this row; all mutable connection state remains
-- server-owned here.

CREATE TYPE "AgentAppConnectionBackend" AS ENUM ('mcp', 'comms_google');
CREATE TYPE "AgentAppConnectionRequestStatus" AS ENUM (
  'offered',
  'connecting',
  'needs_secret',
  'selecting_resources',
  'awaiting_scope_upgrade',
  'awaiting_grant',
  'ready',
  'failed',
  'cancelled',
  'expired',
  'superseded'
);

CREATE TABLE "agent_app_connection_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "thread_id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "origin_run_id" UUID NOT NULL,
  "origin_trigger_message_id" UUID,
  "agent_id" UUID NOT NULL,
  "requested_by_user_id" UUID NOT NULL,
  "candidate_catalog_entry_ids" UUID[] NOT NULL,
  "selected_catalog_entry_id" UUID,
  "connection_backend" "AgentAppConnectionBackend",
  "mcp_instance_id" UUID,
  "comms_connection_id" UUID,
  "scope_type" "McpServerScopeType",
  "scope_id" UUID,
  "status" "AgentAppConnectionRequestStatus" NOT NULL DEFAULT 'offered',
  "consent_snapshot" JSONB NOT NULL,
  "failure_code" TEXT,
  "continuation_run_id" UUID,
  "offer_cooldown_until" TIMESTAMP(3) NOT NULL,
  "connect_attempt_revision" INTEGER NOT NULL DEFAULT 0,
  "returned_at" TIMESTAMP(3),
  "return_revision" INTEGER NOT NULL DEFAULT 0,
  "return_claimed_by_session_id" TEXT,
  "return_claim_lease_expires_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),

  CONSTRAINT "agent_app_connection_requests_pkey" PRIMARY KEY ("id"),
  -- A selected backend may have no connection yet. Once one is attached, it
  -- must be exactly the relation belonging to that backend.
  CONSTRAINT "agent_app_connection_requests_connection_backend_check" CHECK (
    ("mcp_instance_id" IS NULL AND "comms_connection_id" IS NULL)
    OR (
      "connection_backend" = 'mcp'
      AND "mcp_instance_id" IS NOT NULL
      AND "comms_connection_id" IS NULL
    )
    OR (
      "connection_backend" = 'comms_google'
      AND "mcp_instance_id" IS NULL
      AND "comms_connection_id" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "agent_app_connection_requests_message_id_key"
  ON "agent_app_connection_requests"("message_id");
CREATE UNIQUE INDEX "agent_app_connection_requests_continuation_run_id_key"
  ON "agent_app_connection_requests"("continuation_run_id");
CREATE INDEX "app_conn_req_requester_agent_thread_created_idx"
  ON "agent_app_connection_requests"("requested_by_user_id", "agent_id", "thread_id", "created_at" DESC);
CREATE INDEX "app_conn_req_organization_status_expires_idx"
  ON "agent_app_connection_requests"("organization_id", "status", "expires_at");
CREATE INDEX "app_conn_req_requester_returned_idx"
  ON "agent_app_connection_requests"("requested_by_user_id", "returned_at");

ALTER TABLE "agent_app_connection_requests"
  ADD CONSTRAINT "agent_app_connection_requests_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_app_connection_requests_thread_id_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_app_connection_requests_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_app_connection_requests_origin_run_id_fkey"
    FOREIGN KEY ("origin_run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_app_connection_requests_origin_trigger_message_id_fkey"
    FOREIGN KEY ("origin_trigger_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_app_connection_requests_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_app_connection_requests_requested_by_user_id_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_app_connection_requests_selected_catalog_entry_id_fkey"
    FOREIGN KEY ("selected_catalog_entry_id") REFERENCES "mcp_catalog_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_app_connection_requests_mcp_instance_id_fkey"
    FOREIGN KEY ("mcp_instance_id") REFERENCES "mcp_server_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_app_connection_requests_comms_connection_id_fkey"
    FOREIGN KEY ("comms_connection_id") REFERENCES "comms_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_app_connection_requests_continuation_run_id_fkey"
    FOREIGN KEY ("continuation_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
