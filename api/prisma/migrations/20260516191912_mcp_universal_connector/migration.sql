-- MCP Universal Client + Connector Plugin System (Slice B).
-- Adds catalog/instance/credential/grant/bundle tables for the MCP universal
-- connector and extends tool_registry_entries with transport-based dispatch
-- columns. Existing tool_registry_entries rows default to
-- source='builtin', transport='direct', status='active'.

-- CreateEnum
CREATE TYPE "McpCatalogProtocol" AS ENUM ('stdio', 'http', 'sse', 'ws');

-- CreateEnum
CREATE TYPE "McpCatalogAuthMethod" AS ENUM ('api_key', 'bearer', 'basic', 'oauth2', 'none');

-- CreateEnum
CREATE TYPE "McpCatalogStatus" AS ENUM ('draft', 'published', 'deprecated');

-- CreateEnum
CREATE TYPE "McpServerScopeType" AS ENUM ('system', 'organization', 'project', 'team', 'channel', 'user');

-- CreateEnum
CREATE TYPE "McpServerLifecycleState" AS ENUM ('pending_setup', 'active', 'paused', 'error');

-- CreateEnum
CREATE TYPE "McpCredentialPrincipalType" AS ENUM ('user', 'agent', 'channel', 'team', 'project');

-- CreateEnum
CREATE TYPE "ToolRegistrySource" AS ENUM ('builtin', 'custom', 'mcp-remote', 'interactive-session');

-- CreateEnum
CREATE TYPE "ToolRegistryTransport" AS ENUM ('direct', 'mcp', 'http', 'stdio', 'pty');

-- CreateEnum
CREATE TYPE "ToolRegistryEntryStatus" AS ENUM ('active', 'pending_review', 'disabled');

-- CreateEnum
CREATE TYPE "ToolBundleStatus" AS ENUM ('pending_review', 'approved', 'rejected', 'disabled');

-- CreateEnum
CREATE TYPE "ToolGrantState" AS ENUM ('inherit', 'allowed', 'denied');

-- CreateEnum
CREATE TYPE "ToolGrantSource" AS ENUM ('role', 'agent-override');

-- AlterTable: extend tool_registry_entries (defaults backfill existing rows)
ALTER TABLE "tool_registry_entries"
  ADD COLUMN "source"           "ToolRegistrySource"      NOT NULL DEFAULT 'builtin',
  ADD COLUMN "transport"        "ToolRegistryTransport"   NOT NULL DEFAULT 'direct',
  ADD COLUMN "transport_config" JSONB                     NOT NULL DEFAULT '{}',
  ADD COLUMN "bundle_id"        UUID,
  ADD COLUMN "mcp_instance_id"  UUID,
  ADD COLUMN "input_schema"     JSONB                     NOT NULL DEFAULT '{}',
  ADD COLUMN "output_schema"    JSONB,
  ADD COLUMN "tags"             TEXT[]                    NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "status"           "ToolRegistryEntryStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "version"          TEXT                      NOT NULL DEFAULT '0.0.0',
  ADD COLUMN "created_by"       TEXT                      NOT NULL DEFAULT 'system';

-- CreateTable
CREATE TABLE "mcp_catalog_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "protocol" "McpCatalogProtocol" NOT NULL,
    "auth_method" "McpCatalogAuthMethod" NOT NULL,
    "auth_config" JSONB NOT NULL DEFAULT '{}',
    "default_transport_config" JSONB NOT NULL DEFAULT '{}',
    "icon_url" TEXT,
    "vendor" TEXT,
    "source_url" TEXT,
    "signature" TEXT,
    "status" "McpCatalogStatus" NOT NULL DEFAULT 'draft',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_catalog_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_server_instances" (
    "id" UUID NOT NULL,
    "catalog_entry_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "scope_type" "McpServerScopeType" NOT NULL,
    "scope_id" UUID NOT NULL,
    "credential_ref" TEXT,
    "transport_config" JSONB NOT NULL DEFAULT '{}',
    "discovered_tools" JSONB NOT NULL DEFAULT '[]',
    "lifecycle_state" "McpServerLifecycleState" NOT NULL DEFAULT 'pending_setup',
    "health_last_checked_at" TIMESTAMP(3),
    "health_failure_count" INTEGER NOT NULL DEFAULT 0,
    "installed_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_server_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_server_credential_overrides" (
    "id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "principal_type" "McpCredentialPrincipalType" NOT NULL,
    "principal_id" UUID NOT NULL,
    "credential_ref" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_server_credential_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_bundles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "api_version" TEXT NOT NULL,
    "bundle_name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "vendor" TEXT,
    "source_url" TEXT,
    "license" TEXT,
    "signature_type" TEXT,
    "signature_value" TEXT,
    "policy" JSONB NOT NULL DEFAULT '{}',
    "status" "ToolBundleStatus" NOT NULL DEFAULT 'pending_review',
    "imported_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_grants" (
    "id" UUID NOT NULL,
    "tool_id" UUID NOT NULL,
    "state" "ToolGrantState" NOT NULL DEFAULT 'inherit',
    "config" JSONB NOT NULL DEFAULT '{}',
    "source" "ToolGrantSource" NOT NULL,
    "role_id" UUID,
    "agent_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tool_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tool_registry_entries_organization_id_source_idx" ON "tool_registry_entries"("organization_id", "source");

-- CreateIndex
CREATE INDEX "tool_registry_entries_organization_id_status_idx" ON "tool_registry_entries"("organization_id", "status");

-- CreateIndex
CREATE INDEX "tool_registry_entries_bundle_id_idx" ON "tool_registry_entries"("bundle_id");

-- CreateIndex
CREATE INDEX "tool_registry_entries_mcp_instance_id_idx" ON "tool_registry_entries"("mcp_instance_id");

-- CreateIndex
CREATE INDEX "mcp_catalog_entries_organization_id_status_idx" ON "mcp_catalog_entries"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_catalog_entries_organization_id_name_key" ON "mcp_catalog_entries"("organization_id", "name");

-- CreateIndex
CREATE INDEX "mcp_server_instances_organization_id_scope_type_scope_id_idx" ON "mcp_server_instances"("organization_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "mcp_server_instances_organization_id_lifecycle_state_idx" ON "mcp_server_instances"("organization_id", "lifecycle_state");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_instances_catalog_entry_id_scope_type_scope_id_key" ON "mcp_server_instances"("catalog_entry_id", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "mcp_server_credential_overrides_principal_type_principal_id_idx" ON "mcp_server_credential_overrides"("principal_type", "principal_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_server_credential_overrides_instance_id_principal_type__key" ON "mcp_server_credential_overrides"("instance_id", "principal_type", "principal_id");

-- CreateIndex
CREATE INDEX "tool_bundles_organization_id_status_idx" ON "tool_bundles"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tool_bundles_organization_id_bundle_name_version_key" ON "tool_bundles"("organization_id", "bundle_name", "version");

-- CreateIndex
CREATE INDEX "tool_grants_tool_id_idx" ON "tool_grants"("tool_id");

-- CreateIndex
CREATE INDEX "tool_grants_role_id_idx" ON "tool_grants"("role_id");

-- CreateIndex
CREATE INDEX "tool_grants_agent_id_idx" ON "tool_grants"("agent_id");

-- AddForeignKey
ALTER TABLE "tool_registry_entries" ADD CONSTRAINT "tool_registry_entries_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "tool_bundles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_registry_entries" ADD CONSTRAINT "tool_registry_entries_mcp_instance_id_fkey" FOREIGN KEY ("mcp_instance_id") REFERENCES "mcp_server_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_server_instances" ADD CONSTRAINT "mcp_server_instances_catalog_entry_id_fkey" FOREIGN KEY ("catalog_entry_id") REFERENCES "mcp_catalog_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_server_credential_overrides" ADD CONSTRAINT "mcp_server_credential_overrides_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "mcp_server_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_grants" ADD CONSTRAINT "tool_grants_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tool_registry_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
