CREATE TYPE "UserStatusScheduleKind" AS ENUM ('date_range', 'weekly');
CREATE TYPE "UserStatusRuleScope" AS ENUM ('fallback', 'channel', 'project');

CREATE TABLE "user_statuses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "emoji" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "agent_enabled" BOOLEAN NOT NULL DEFAULT false,
    "agent_instructions" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_statuses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_status_schedules" (
    "id" UUID NOT NULL,
    "status_id" UUID NOT NULL,
    "kind" "UserStatusScheduleKind" NOT NULL,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "day_of_week" INTEGER,
    "start_time" TEXT,
    "end_time" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_status_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_status_schedules_day_of_week_check"
        CHECK ("day_of_week" IS NULL OR ("day_of_week" >= 0 AND "day_of_week" <= 6)),
    CONSTRAINT "user_status_schedules_kind_fields_check"
        CHECK (
            (
                "kind" = 'date_range'
                AND "starts_at" IS NOT NULL
                AND "ends_at" IS NOT NULL
                AND "day_of_week" IS NULL
                AND "start_time" IS NULL
                AND "end_time" IS NULL
            )
            OR (
                "kind" = 'weekly'
                AND "starts_at" IS NULL
                AND "ends_at" IS NULL
                AND "day_of_week" IS NOT NULL
                AND "start_time" IS NOT NULL
                AND "end_time" IS NOT NULL
            )
        )
);

CREATE TABLE "user_status_rules" (
    "id" UUID NOT NULL,
    "status_id" UUID NOT NULL,
    "scope" "UserStatusRuleScope" NOT NULL DEFAULT 'fallback',
    "channel_id" UUID,
    "project_id" UUID,
    "agent_id" UUID,
    "agent_enabled" BOOLEAN NOT NULL DEFAULT true,
    "instructions" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_status_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_status_rules_scope_target_check"
        CHECK (
            (
                "scope" = 'fallback'
                AND "channel_id" IS NULL
                AND "project_id" IS NULL
            )
            OR (
                "scope" = 'channel'
                AND "channel_id" IS NOT NULL
                AND "project_id" IS NULL
            )
            OR (
                "scope" = 'project'
                AND "channel_id" IS NULL
                AND "project_id" IS NOT NULL
            )
        )
);

CREATE INDEX "user_statuses_organization_id_user_id_idx"
    ON "user_statuses"("organization_id", "user_id");
CREATE INDEX "user_statuses_user_id_is_active_idx"
    ON "user_statuses"("user_id", "is_active");
CREATE UNIQUE INDEX "user_statuses_one_active_manual_idx"
    ON "user_statuses"("organization_id", "user_id")
    WHERE "is_active";

CREATE INDEX "user_status_schedules_status_id_idx"
    ON "user_status_schedules"("status_id");
CREATE INDEX "user_status_schedules_kind_enabled_idx"
    ON "user_status_schedules"("kind", "enabled");

CREATE INDEX "user_status_rules_status_id_priority_idx"
    ON "user_status_rules"("status_id", "priority");
CREATE INDEX "user_status_rules_channel_id_idx"
    ON "user_status_rules"("channel_id");
CREATE INDEX "user_status_rules_project_id_idx"
    ON "user_status_rules"("project_id");
CREATE INDEX "user_status_rules_agent_id_idx"
    ON "user_status_rules"("agent_id");

ALTER TABLE "user_statuses"
    ADD CONSTRAINT "user_statuses_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_statuses"
    ADD CONSTRAINT "user_statuses_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_status_schedules"
    ADD CONSTRAINT "user_status_schedules_status_id_fkey"
    FOREIGN KEY ("status_id") REFERENCES "user_statuses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_status_rules"
    ADD CONSTRAINT "user_status_rules_status_id_fkey"
    FOREIGN KEY ("status_id") REFERENCES "user_statuses"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_status_rules"
    ADD CONSTRAINT "user_status_rules_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_status_rules"
    ADD CONSTRAINT "user_status_rules_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_status_rules"
    ADD CONSTRAINT "user_status_rules_agent_id_fkey"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
