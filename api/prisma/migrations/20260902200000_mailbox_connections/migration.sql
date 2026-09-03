-- SMTP/IMAP mailbox connections — agent email Model A.
-- Design: docs/plans/2026-09-02-agent-email.md §2.2.
--
-- The provider holds the mail; Nessie holds a credential, an audit trail, and
-- the answer to "which agent may use which mailbox". Nothing is synced and no
-- copy of anybody's correspondence is stored — that is the whole difference
-- between this and the hosted mailbox in 20260902140000_agent_email.

CREATE TYPE "MailboxTransportSecurity" AS ENUM ('tls', 'starttls');
CREATE TYPE "MailboxConnectionStatus" AS ENUM ('active', 'needs_reauthorization', 'disabled');

CREATE TABLE "mailbox_connections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "owner_user_id" UUID,
    "team_id" UUID,
    "label" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "imap_host" TEXT NOT NULL,
    "imap_port" INTEGER NOT NULL,
    "imap_security" "MailboxTransportSecurity" NOT NULL DEFAULT 'tls',
    "smtp_host" TEXT NOT NULL,
    "smtp_port" INTEGER NOT NULL,
    "smtp_security" "MailboxTransportSecurity" NOT NULL DEFAULT 'starttls',
    "username" TEXT NOT NULL,
    "status" "MailboxConnectionStatus" NOT NULL DEFAULT 'active',
    "status_reason" TEXT,
    "last_verified_at" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailbox_connections_pkey" PRIMARY KEY ("id")
);

-- Scope IS which owner column is set, so there is no separate `scope` column to
-- drift out of agreement with the ids. Exactly one, never both and never
-- neither: a connection with no scope would be reachable by nobody's rules.
ALTER TABLE "mailbox_connections"
  ADD CONSTRAINT "mailbox_connections_scope_chk"
  CHECK (("owner_user_id" IS NOT NULL) <> ("team_id" IS NOT NULL));

-- Ports are dialled, so a nonsense value is a failure at connect time in
-- production and a validation error here instead.
ALTER TABLE "mailbox_connections"
  ADD CONSTRAINT "mailbox_connections_ports_chk"
  CHECK (
    "imap_port" BETWEEN 1 AND 65535
    AND "smtp_port" BETWEEN 1 AND 65535
  );

ALTER TABLE "mailbox_connections"
  ADD CONSTRAINT "mailbox_connections_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mailbox_connections"
  ADD CONSTRAINT "mailbox_connections_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenancy in the database, following the Agent.ownerUserId precedent: the
-- composite key proves the owner is a member of THIS organization, so no write
-- path can attach one person's mailbox to another tenant. NO ACTION rather than
-- SET NULL because on a composite key SET NULL blanks organization_id too.
ALTER TABLE "mailbox_connections"
  ADD CONSTRAINT "mailbox_connections_organization_id_owner_user_id_fkey"
  FOREIGN KEY ("organization_id", "owner_user_id")
  REFERENCES "organization_members"("organization_id", "user_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "mailbox_connections_organization_id_status_idx" ON "mailbox_connections"("organization_id", "status");
CREATE INDEX "mailbox_connections_organization_id_owner_user_id_idx" ON "mailbox_connections"("organization_id", "owner_user_id");
CREATE INDEX "mailbox_connections_team_id_idx" ON "mailbox_connections"("team_id");

-- One address per scope. Partial indexes rather than one composite unique,
-- because PostgreSQL treats NULLs as distinct: a composite over a nullable
-- owner column would not stop a team connecting the same mailbox twice.
CREATE UNIQUE INDEX "mailbox_connections_user_address_key"
  ON "mailbox_connections"("organization_id", "owner_user_id", "address")
  WHERE "owner_user_id" IS NOT NULL;
CREATE UNIQUE INDEX "mailbox_connections_team_address_key"
  ON "mailbox_connections"("team_id", "address")
  WHERE "team_id" IS NOT NULL;

CREATE TABLE "mailbox_connection_credentials" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mailbox_connection_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mailbox_connection_credentials_connection_id_key" ON "mailbox_connection_credentials"("connection_id");

ALTER TABLE "mailbox_connection_credentials"
  ADD CONSTRAINT "mailbox_connection_credentials_connection_id_fkey"
  FOREIGN KEY ("connection_id") REFERENCES "mailbox_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which agent may use which mailbox. `Agent.toolPolicy` is keyed by tool id and
-- cannot name a resource, so a bare tool grant would silently widen to every
-- mailbox connected afterwards; access is a per-pair row instead.
CREATE TABLE "mailbox_connection_agent_access" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "granted_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mailbox_connection_agent_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mailbox_connection_agent_access_connection_id_agent_id_key" ON "mailbox_connection_agent_access"("connection_id", "agent_id");
CREATE INDEX "mailbox_connection_agent_access_organization_id_agent_id_idx" ON "mailbox_connection_agent_access"("organization_id", "agent_id");

ALTER TABLE "mailbox_connection_agent_access"
  ADD CONSTRAINT "mailbox_connection_agent_access_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mailbox_connection_agent_access"
  ADD CONSTRAINT "mailbox_connection_agent_access_connection_id_fkey"
  FOREIGN KEY ("connection_id") REFERENCES "mailbox_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The composite agent key carries the organization, so an access row cannot
-- name an agent from another tenant.
ALTER TABLE "mailbox_connection_agent_access"
  ADD CONSTRAINT "mailbox_connection_agent_access_organization_id_agent_id_fkey"
  FOREIGN KEY ("organization_id", "agent_id")
  REFERENCES "agents"("organization_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
