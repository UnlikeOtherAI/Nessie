-- CreateEnum
CREATE TYPE "ThoughtOwnerType" AS ENUM ('user', 'agent', 'service');

-- CreateEnum
CREATE TYPE "ThoughtVisibility" AS ENUM ('private', 'channel', 'team', 'project', 'organization');

-- CreateEnum
CREATE TYPE "SensitivityTier" AS ENUM ('normal', 'sensitive', 'restricted');

-- CreateEnum
CREATE TYPE "ReasoningType" AS ENUM ('decision', 'evaluation', 'constraint', 'pattern', 'correction', 'validation');

-- CreateEnum
CREATE TYPE "OutcomeStatus" AS ENUM ('pending', 'successful', 'partially', 'failed', 'superseded');

-- CreateEnum
CREATE TYPE "ThoughtLinkRelation" AS ENUM ('supersedes', 'derived_from', 'contradicts', 'supports', 'relates_to');

-- CreateTable
CREATE TABLE "thoughts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "content" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "owner_type" "ThoughtOwnerType" NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "team_id" UUID,
    "channel_id" UUID,
    "thread_id" UUID,
    "visibility" "ThoughtVisibility" NOT NULL DEFAULT 'private',
    "sensitivity_tier" "SensitivityTier" NOT NULL DEFAULT 'normal',
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "metadata" JSONB,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "thoughts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thought_reasonings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "thought_id" UUID NOT NULL,
    "reasoning_type" "ReasoningType" NOT NULL,
    "alternatives" JSONB,
    "criteria" JSONB,
    "constraints" JSONB,
    "tradeoffs" TEXT,
    "confidence" DOUBLE PRECISION,
    "reasoning" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "outcome" "OutcomeStatus" NOT NULL DEFAULT 'pending',
    "outcome_notes" TEXT,
    "outcome_at" TIMESTAMP(3),
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "thought_reasonings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thought_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "relation" "ThoughtLinkRelation" NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thought_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thought_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "thought_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "diff" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thought_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "thoughts_organization_id_visibility_created_at_idx" ON "thoughts"("organization_id", "visibility", "created_at");

-- CreateIndex
CREATE INDEX "thoughts_organization_id_owner_id_owner_type_idx" ON "thoughts"("organization_id", "owner_id", "owner_type");

-- CreateIndex
CREATE INDEX "thoughts_content_hash_idx" ON "thoughts"("content_hash");

-- CreateIndex
CREATE INDEX "thoughts_channel_id_created_at_idx" ON "thoughts"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX "thought_reasonings_thought_id_created_at_idx" ON "thought_reasonings"("thought_id", "created_at");

-- CreateIndex
CREATE INDEX "thought_reasonings_organization_id_outcome_idx" ON "thought_reasonings"("organization_id", "outcome");

-- CreateIndex
CREATE INDEX "thought_reasonings_organization_id_actor_id_idx" ON "thought_reasonings"("organization_id", "actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "thought_links_source_id_target_id_relation_key" ON "thought_links"("source_id", "target_id", "relation");

-- CreateIndex
CREATE INDEX "thought_links_target_id_idx" ON "thought_links"("target_id");

-- CreateIndex
CREATE INDEX "thought_audit_logs_thought_id_created_at_idx" ON "thought_audit_logs"("thought_id", "created_at");

-- AddForeignKey
ALTER TABLE "thoughts" ADD CONSTRAINT "thoughts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thought_reasonings" ADD CONSTRAINT "thought_reasonings_thought_id_fkey" FOREIGN KEY ("thought_id") REFERENCES "thoughts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thought_links" ADD CONSTRAINT "thought_links_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "thoughts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thought_links" ADD CONSTRAINT "thought_links_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "thoughts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thought_audit_logs" ADD CONSTRAINT "thought_audit_logs_thought_id_fkey" FOREIGN KEY ("thought_id") REFERENCES "thoughts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
