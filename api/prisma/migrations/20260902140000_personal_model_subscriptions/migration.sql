-- Personal model subscriptions.
--
-- A person links their own consumer AI plan (Kimi, GLM today; OpenAI Codex and
-- xAI Grok with the OAuth phase) and the agents THEY own run on it instead of
-- on the organization's Ledger credits.
--
-- Token values are NOT in this schema: `docs/secret-management-spec.md` bars
-- new secret-capture flows from putting values in PostgreSQL, so the bundle
-- lives in the deployment's dedicated model-subscription vault project and
-- `model_subscription_credentials` holds only the pointer plus the metadata the
-- coordinator needs to serialize rotation.
--
-- Spec: docs/plans/2026-09-02-personal-model-subscriptions.md

-- CreateEnum
CREATE TYPE "ModelSubscriptionProvider" AS ENUM ('kimi', 'glm', 'openai-codex', 'grok');

-- CreateEnum
CREATE TYPE "ModelSubscriptionStatus" AS ENUM ('active', 'needs_reauthorization', 'disconnected', 'error');

-- CreateEnum
CREATE TYPE "ModelSubscriptionHealthReason" AS ENUM ('ok', 'needs_reauthorization', 'provider_rejected', 'quota_exhausted', 'owner_inactive', 'vault_unavailable');

-- CreateEnum
CREATE TYPE "InferenceBillingSource" AS ENUM ('ledger', 'personal_subscription');

-- CreateTable
CREATE TABLE "model_subscriptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "ModelSubscriptionProvider" NOT NULL,
    "status" "ModelSubscriptionStatus" NOT NULL DEFAULT 'active',
    "provider_account_id" TEXT NOT NULL,
    "account_label" TEXT,
    "credential_epoch" INTEGER NOT NULL DEFAULT 1,
    "refresh_claimed_at" TIMESTAMP(3),
    "health_reason" "ModelSubscriptionHealthReason" NOT NULL DEFAULT 'ok',
    "health_detail" TEXT,
    "health_revision" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_subscription_credentials" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "vault_reference" TEXT NOT NULL,
    "vault_secret_name" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_subscription_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_subscription_vault_tombstones" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "vault_secret_name" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_subscription_vault_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_subscription_auth_states" (
    "token" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "ModelSubscriptionProvider" NOT NULL,
    "payload" JSONB NOT NULL,
    "poll_lease_until" TIMESTAMP(3),
    "next_poll_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_subscription_auth_states_pkey" PRIMARY KEY ("token")
);

-- AlterTable
ALTER TABLE "agents" ADD COLUMN "model_subscription_id" UUID;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "model_subscription_epoch" INTEGER,
ADD COLUMN "model_subscription_id" UUID;

-- AlterTable
ALTER TABLE "token_ledger_events" ADD COLUMN "billing_source" "InferenceBillingSource" NOT NULL DEFAULT 'ledger',
ADD COLUMN "model_subscription_id" UUID;

-- CreateIndex
CREATE INDEX "model_subscriptions_organization_id_user_id_idx" ON "model_subscriptions"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "model_subscriptions_status_idx" ON "model_subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "model_subscriptions_organization_id_user_id_provider_provid_key" ON "model_subscriptions"("organization_id", "user_id", "provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_subscription_credentials_subscription_id_key" ON "model_subscription_credentials"("subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_subscription_credentials_vault_reference_key" ON "model_subscription_credentials"("vault_reference");

-- CreateIndex
CREATE INDEX "model_subscription_vault_tombstones_deleted_at_created_at_idx" ON "model_subscription_vault_tombstones"("deleted_at", "created_at");

-- CreateIndex
CREATE INDEX "model_subscription_auth_states_organization_id_user_id_idx" ON "model_subscription_auth_states"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "model_subscription_auth_states_expires_at_idx" ON "model_subscription_auth_states"("expires_at");

-- AddForeignKey
ALTER TABLE "model_subscriptions" ADD CONSTRAINT "model_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenancy at the storage boundary, mirroring `agents_organization_id_owner_user_id_fkey`:
-- the owner must be a member of THIS organization. NO ACTION because on a
-- composite key SET NULL would blank every referencing column, organization_id
-- included. It proves the membership row exists, never that it is live — every
-- read re-derives `deactivated_at IS NULL`.
-- AddForeignKey
ALTER TABLE "model_subscriptions" ADD CONSTRAINT "model_subscriptions_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "organization_members"("organization_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "model_subscription_credentials" ADD CONSTRAINT "model_subscription_credentials_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "model_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, not CASCADE: disconnecting a subscription must never delete the
-- agent or the run. The run-time gate then fails closed on the dangling
-- selection and names the remedy.
-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_model_subscription_id_fkey" FOREIGN KEY ("model_subscription_id") REFERENCES "model_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_subscription_id_fkey" FOREIGN KEY ("model_subscription_id") REFERENCES "model_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
