-- CreateEnum
CREATE TYPE "AgentKind" AS ENUM ('shared', 'personal_assistant');

-- CreateEnum
CREATE TYPE "AgentSurfacePolicy" AS ENUM ('shared', 'dm_only');

-- CreateEnum
CREATE TYPE "AgentDelegationMode" AS ENUM ('none', 'act_as_requesting_user');

-- CreateEnum
CREATE TYPE "ChannelSystemType" AS ENUM ('personal_assistant');

-- AlterTable
ALTER TABLE "agents"
  ADD COLUMN "agent_kind" "AgentKind" NOT NULL DEFAULT 'shared',
  ADD COLUMN "delegation_mode" "AgentDelegationMode" NOT NULL DEFAULT 'none',
  ADD COLUMN "surface_policy" "AgentSurfacePolicy" NOT NULL DEFAULT 'shared',
  ADD COLUMN "system_managed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "channels"
  ADD COLUMN "system_channel_type" "ChannelSystemType";

-- CreateIndex
CREATE INDEX "agents_organization_id_agent_kind_system_managed_idx"
  ON "agents"("organization_id", "agent_kind", "system_managed");

-- CreateIndex
CREATE INDEX "channels_system_channel_type_idx"
  ON "channels"("system_channel_type");

-- CreateIndex
CREATE UNIQUE INDEX "agents_personal_assistant_organization_id_key"
  ON "agents"("organization_id")
  WHERE "agent_kind" = 'personal_assistant' AND "system_managed" = TRUE;

-- Add constraints to keep the PA invariants on-database, not just in code.
ALTER TABLE "agents"
  ADD CONSTRAINT "agents_personal_assistant_system_invariants_chk"
  CHECK (
    (
      "system_managed" = FALSE
      AND "agent_kind" = 'shared'
      AND "surface_policy" = 'shared'
      AND "delegation_mode" = 'none'
    )
    OR
    (
      "system_managed" = TRUE
      AND "agent_kind" = 'personal_assistant'
      AND "surface_policy" = 'dm_only'
      AND "delegation_mode" = 'act_as_requesting_user'
    )
  );

ALTER TABLE "channels"
  ADD CONSTRAINT "channels_personal_assistant_surface_chk"
  CHECK (
    "system_channel_type" IS NULL
    OR (
      "type" = 'dm'
      AND "visibility" = 'private'
      AND "dm_key" LIKE 'pa:%'
    )
  );
