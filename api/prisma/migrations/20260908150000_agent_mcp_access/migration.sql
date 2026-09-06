-- Agent access to the MCP server: a scoped, revocable credential and the
-- human-approved pairing that mints it.
--
-- Nessie has been an MCP *client* (`/api/mcp/*` manages connectors it calls
-- out to); nothing let an agent call in. The blocker was never the tools, it
-- was the credential: a session JWT is a 15-minute browser token refreshed by
-- a cookie and scoped to everything its holder can do, which a headless agent
-- can neither refresh nor safely hold.
--
-- Shape follows `voice_device_credentials` deliberately — the established
-- answer here to "a non-browser client needs a scoped, revocable credential".
-- Both tables hash their secret at rest; the plaintext exists only in the
-- response that returned it.

CREATE TYPE "AgentAccessScope" AS ENUM (
  'boards_read',
  'boards_write',
  'documents_read',
  'documents_write'
);

CREATE TYPE "AgentAuthorizationStatus" AS ENUM (
  'pending',
  'approved',
  'denied',
  'expired'
);

-- RFC 8628 device authorization grant. A CLI agent has no browser it controls
-- and no callback URL, so it prints a short code a human types in the admin.
-- The approval is what mints access: the credential inherits the approving
-- person's entitlements, so a person has to choose to lend them.
CREATE TABLE "agent_authorization_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "device_code_hash" TEXT NOT NULL,
  "user_code" TEXT NOT NULL,
  "client_name" TEXT NOT NULL,
  "requested_scopes" "AgentAccessScope"[] NOT NULL DEFAULT ARRAY[]::"AgentAccessScope"[],
  "status" "AgentAuthorizationStatus" NOT NULL DEFAULT 'pending',
  "approved_by_user_id" UUID,
  "approved_scopes" "AgentAccessScope"[] NOT NULL DEFAULT ARRAY[]::"AgentAccessScope"[],
  "approved_organization_id" UUID,
  "approved_project_id" UUID,
  "approved_team_id" UUID,
  "approved_at" TIMESTAMP(3),
  "redeemed_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "last_polled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_authorization_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_authorization_requests_device_code_hash_key"
  ON "agent_authorization_requests"("device_code_hash");
CREATE UNIQUE INDEX "agent_authorization_requests_user_code_key"
  ON "agent_authorization_requests"("user_code");
CREATE INDEX "agent_authorization_requests_status_expires_at_idx"
  ON "agent_authorization_requests"("status", "expires_at");

ALTER TABLE "agent_authorization_requests"
  ADD CONSTRAINT "agent_authorization_requests_approved_by_user_id_fkey"
  FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "agent_access_credentials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  -- The human this credential acts as. Their entitlements are the ceiling; the
  -- credential is never an identity of its own.
  "user_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "token_prefix" TEXT NOT NULL,
  "scopes" "AgentAccessScope"[] NOT NULL DEFAULT ARRAY[]::"AgentAccessScope"[],
  "project_id" UUID NOT NULL,
  "team_id" UUID,
  -- `users.token_version` at mint time, so a forced sign-out kills every
  -- credential that human minted at the same instant it kills their sessions.
  "token_version" INTEGER NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "last_used_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_access_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_access_credentials_token_hash_key"
  ON "agent_access_credentials"("token_hash");
CREATE INDEX "agent_access_credentials_user_id_revoked_at_idx"
  ON "agent_access_credentials"("user_id", "revoked_at");
CREATE INDEX "agent_access_credentials_organization_id_revoked_at_idx"
  ON "agent_access_credentials"("organization_id", "revoked_at");

ALTER TABLE "agent_access_credentials"
  ADD CONSTRAINT "agent_access_credentials_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_access_credentials"
  ADD CONSTRAINT "agent_access_credentials_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
