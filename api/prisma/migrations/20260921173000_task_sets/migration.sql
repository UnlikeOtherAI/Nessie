-- AlterEnum
ALTER TYPE "UserAlertKind" ADD VALUE 'task_set_health';

-- AlterTable
ALTER TABLE "user_alerts" ADD COLUMN     "task_set_id" UUID;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "inference_resource_admission_id" UUID;

-- AlterTable
ALTER TABLE "local_inference_hosts" ADD COLUMN     "inference_resource_id" UUID;

-- AlterTable
ALTER TABLE "local_inference_attempts" ADD COLUMN     "resource_admission_id" UUID;

-- CreateTable
CREATE TABLE "local_inference_resources" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "custodian_user_id" UUID NOT NULL,
    "public_key" TEXT NOT NULL,
    "public_key_fingerprint" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "paused_at" TIMESTAMP(3),
    "control_revision" INTEGER NOT NULL DEFAULT 1,
    "health_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "local_inference_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inference_resource_admissions" (
    "id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "reservation_key" TEXT NOT NULL,
    "run_id" UUID,
    "attempt_id" UUID,
    "fence" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'reserved',
    "confirmed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inference_resource_admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_sets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "execution_agent_id" UUID NOT NULL,
    "execution_thread_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "processor" JSONB NOT NULL,
    "capacity_key" TEXT NOT NULL,
    "source" JSONB,
    "source_version_id" UUID,
    "output" JSONB NOT NULL,
    "receiver" JSONB,
    "launch_origin" JSONB NOT NULL,
    "disclosure" JSONB NOT NULL,
    "search" TEXT NOT NULL DEFAULT 'none',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reason" TEXT,
    "max_parallel_requests" INTEGER NOT NULL DEFAULT 1,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "total_items" INTEGER NOT NULL DEFAULT 0,
    "completed_items" INTEGER NOT NULL DEFAULT 0,
    "skipped_items" INTEGER NOT NULL DEFAULT 0,
    "next_sequence" INTEGER NOT NULL DEFAULT 1,
    "import_ordinal" INTEGER NOT NULL DEFAULT 0,
    "input_closed_at" TIMESTAMP(3),
    "current_item_id" UUID,
    "origin_thread_id" UUID,
    "origin_message_id" UUID,
    "output_page_id" UUID,
    "output_state" JSONB,
    "delivery_status" TEXT NOT NULL DEFAULT 'none',
    "health_revision" INTEGER NOT NULL DEFAULT 0,
    "offline_since" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_set_items" (
    "id" UUID NOT NULL,
    "task_set_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "client_key" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "dependencies" UUID[] DEFAULT ARRAY[]::UUID[],
    "source_locator" TEXT,
    "disclosure" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "result" TEXT,
    "result_disclosure" JSONB,
    "output_page_id" UUID,
    "current_attempt_id" UUID,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_set_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_set_attempts" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "run_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "fence" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_set_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "local_inference_resources_public_key_fingerprint_key" ON "local_inference_resources"("public_key_fingerprint");

-- CreateIndex
CREATE INDEX "local_inference_resources_organization_id_custodian_user_id_idx" ON "local_inference_resources"("organization_id", "custodian_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "inference_resource_admissions_reservation_key_key" ON "inference_resource_admissions"("reservation_key");

-- CreateIndex
CREATE UNIQUE INDEX "inference_resource_admissions_attempt_id_key" ON "inference_resource_admissions"("attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "inference_resource_admissions_fence_key" ON "inference_resource_admissions"("fence");

-- CreateIndex
CREATE INDEX "inference_resource_admissions_resource_id_state_idx" ON "inference_resource_admissions"("resource_id", "state");

-- CreateIndex
CREATE INDEX "task_sets_organization_id_owner_user_id_created_at_id_idx" ON "task_sets"("organization_id", "owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "task_sets_status_next_attempt_at_idx" ON "task_sets"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "task_sets_capacity_key_status_idx" ON "task_sets"("capacity_key", "status");

-- CreateIndex
CREATE INDEX "task_sets_source_version_id_idx" ON "task_sets"("source_version_id");

-- CreateIndex
CREATE INDEX "task_set_items_task_set_id_status_sequence_idx" ON "task_set_items"("task_set_id", "status", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "task_set_items_task_set_id_sequence_key" ON "task_set_items"("task_set_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "task_set_items_task_set_id_client_key_key" ON "task_set_items"("task_set_id", "client_key");

-- CreateIndex
CREATE UNIQUE INDEX "task_set_attempts_run_id_key" ON "task_set_attempts"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_set_attempts_item_id_number_key" ON "task_set_attempts"("item_id", "number");

-- CreateIndex
CREATE INDEX "local_inference_hosts_inference_resource_id_idx" ON "local_inference_hosts"("inference_resource_id");

-- CreateIndex
CREATE INDEX "local_inference_attempts_resource_admission_id_idx" ON "local_inference_attempts"("resource_admission_id");

-- AddForeignKey
ALTER TABLE "user_alerts" ADD CONSTRAINT "user_alerts_task_set_id_fkey" FOREIGN KEY ("task_set_id") REFERENCES "task_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inference_resource_admissions" ADD CONSTRAINT "inference_resource_admissions_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "local_inference_resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_set_items" ADD CONSTRAINT "task_set_items_task_set_id_fkey" FOREIGN KEY ("task_set_id") REFERENCES "task_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_set_attempts" ADD CONSTRAINT "task_set_attempts_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "task_set_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sequence and capacity invariants are enforced independently of a caller.
ALTER TABLE "task_sets" ADD CONSTRAINT "task_sets_positive_limits" CHECK (max_parallel_requests BETWEEN 1 AND 32 AND max_attempts BETWEEN 1 AND 10 AND next_sequence >= 1);
ALTER TABLE "task_set_items" ADD CONSTRAINT "task_set_items_positive_sequence" CHECK (sequence >= 1);
CREATE UNIQUE INDEX "task_set_items_one_running" ON "task_set_items" (task_set_id) WHERE status = 'running';
ALTER TABLE "local_inference_resources" ADD CONSTRAINT "local_inference_resources_capacity" CHECK (capacity BETWEEN 1 AND 32);
ALTER TABLE "task_sets" ADD CONSTRAINT "task_sets_source_version_retention" FOREIGN KEY (source_version_id) REFERENCES knowledge_page_versions(id) ON DELETE RESTRICT;
