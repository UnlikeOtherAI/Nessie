-- CreateEnum
CREATE TYPE "DashboardHome" AS ENUM ('organization', 'project', 'team', 'channel', 'personal');

-- CreateEnum
CREATE TYPE "DashboardAuthorType" AS ENUM ('user', 'agent');

-- CreateEnum
CREATE TYPE "DashboardSourceKind" AS ENUM ('http');

-- CreateEnum
CREATE TYPE "DashboardRefreshMode" AS ENUM ('manual', 'interval');

-- CreateEnum
CREATE TYPE "DashboardGrantLevel" AS ENUM ('view', 'edit');

-- CreateEnum
CREATE TYPE "DashboardAccessMode" AS ENUM ('delegated', 'viewer');

-- CreateTable
CREATE TABLE "dashboards" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "home" "DashboardHome" NOT NULL,
    "project_id" UUID,
    "team_id" UUID,
    "channel_id" UUID,
    "owner_user_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "layout" JSONB NOT NULL DEFAULT '{"lg":[],"md":[],"sm":[]}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_by_type" "DashboardAuthorType" NOT NULL,
    "created_by" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_data_sources" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DashboardSourceKind" NOT NULL DEFAULT 'http',
    "origin" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '/',
    "query_params" JSONB,
    "credential_ref" TEXT,
    "credential_mode" TEXT,
    "credential_header" TEXT,
    "authority_user_id" UUID NOT NULL,
    "access_mode" "DashboardAccessMode" NOT NULL DEFAULT 'delegated',
    "transform" TEXT NOT NULL,
    "output_columns" JSONB NOT NULL,
    "refresh_mode" "DashboardRefreshMode" NOT NULL DEFAULT 'manual',
    "interval_minutes" INTEGER,
    "cache_ttl_seconds" INTEGER NOT NULL DEFAULT 300,
    "latest_dataset_id" UUID,
    "last_attempt_at" TIMESTAMP(3),
    "last_validated_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "etag" TEXT,
    "last_modified" TEXT,
    "created_by_type" "DashboardAuthorType" NOT NULL,
    "created_by" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_datasets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "attachment_id" UUID NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "row_count" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_widgets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "dashboard_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "spec" JSONB NOT NULL,
    "locked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_widget_snapshots" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "widget_id" UUID NOT NULL,
    "dashboard_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "spec" JSONB NOT NULL,
    "dataset_id" UUID NOT NULL,
    "taken_by_type" "DashboardAuthorType" NOT NULL,
    "taken_by_id" TEXT NOT NULL,
    "authority_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_widget_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "dashboard_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "layout" JSONB NOT NULL,
    "widgets" JSONB NOT NULL,
    "author_type" "DashboardAuthorType" NOT NULL,
    "author_id" TEXT NOT NULL,
    "run_id" UUID,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_grants" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "level" "DashboardGrantLevel" NOT NULL,
    "created_by" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_embed_placements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "widget_id" UUID,
    "widget_snapshot_id" UUID,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashboard_embed_placements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dashboards_organization_id_home_archived_at_idx" ON "dashboards"("organization_id", "home", "archived_at");

-- CreateIndex
CREATE INDEX "dashboards_organization_id_project_id_idx" ON "dashboards"("organization_id", "project_id");

-- CreateIndex
CREATE INDEX "dashboard_data_sources_next_run_at_claimed_at_idx" ON "dashboard_data_sources"("next_run_at", "claimed_at");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_data_sources_organization_id_name_key" ON "dashboard_data_sources"("organization_id", "name");

-- CreateIndex
CREATE INDEX "dashboard_datasets_organization_id_source_id_fetched_at_idx" ON "dashboard_datasets"("organization_id", "source_id", "fetched_at" DESC);

-- CreateIndex
CREATE INDEX "dashboard_widgets_organization_id_dashboard_id_idx" ON "dashboard_widgets"("organization_id", "dashboard_id");

-- CreateIndex
CREATE INDEX "dashboard_widget_snapshots_organization_id_widget_id_idx" ON "dashboard_widget_snapshots"("organization_id", "widget_id");

-- CreateIndex
CREATE INDEX "dashboard_versions_organization_id_dashboard_id_created_at_idx" ON "dashboard_versions"("organization_id", "dashboard_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_versions_dashboard_id_version_number_key" ON "dashboard_versions"("dashboard_id", "version_number");

-- CreateIndex
CREATE INDEX "dashboard_grants_organization_id_subject_type_subject_id_idx" ON "dashboard_grants"("organization_id", "subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_grants_resource_type_resource_id_subject_type_sub_key" ON "dashboard_grants"("resource_type", "resource_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "dashboard_embed_placements_organization_id_target_type_targ_idx" ON "dashboard_embed_placements"("organization_id", "target_type", "target_id");

-- AddForeignKey
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_data_sources" ADD CONSTRAINT "dashboard_data_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_datasets" ADD CONSTRAINT "dashboard_datasets_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "dashboard_data_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "dashboard_data_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_widget_snapshots" ADD CONSTRAINT "dashboard_widget_snapshots_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "dashboard_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_versions" ADD CONSTRAINT "dashboard_versions_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A dashboard's `home` and its scope column must agree. Prisma cannot express
-- this, and an unmatched pair would silently widen an audience: a row claiming
-- home='personal' while carrying a project_id would read as personal in the UI
-- and as project-scoped in an entitlement query. Enforced in the database so no
-- code path can create one.
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_home_scope_check" CHECK (
  (home = 'organization' AND project_id IS NULL AND team_id IS NULL
     AND channel_id IS NULL AND owner_user_id IS NULL)
  OR (home = 'project' AND project_id IS NOT NULL AND team_id IS NULL
     AND channel_id IS NULL AND owner_user_id IS NULL)
  OR (home = 'team' AND team_id IS NOT NULL AND project_id IS NULL
     AND channel_id IS NULL AND owner_user_id IS NULL)
  OR (home = 'channel' AND channel_id IS NOT NULL AND project_id IS NULL
     AND team_id IS NULL AND owner_user_id IS NULL)
  OR (home = 'personal' AND owner_user_id IS NOT NULL AND project_id IS NULL
     AND team_id IS NULL AND channel_id IS NULL)
);

-- An embed points at exactly one of a live widget or a frozen snapshot, and the
-- pointer must match its declared mode. A row with both set, or with mode='live'
-- pointing at a snapshot, makes the resolver's authorization branch ambiguous —
-- and an ambiguous authorization branch is a bypass waiting to be found.
ALTER TABLE "dashboard_embed_placements"
  ADD CONSTRAINT "dashboard_embed_placements_mode_target_check" CHECK (
    (mode = 'live' AND widget_id IS NOT NULL AND widget_snapshot_id IS NULL)
    OR (mode = 'static' AND widget_snapshot_id IS NOT NULL AND widget_id IS NULL)
  );

-- A scheduled source must carry an interval, and it can never be shorter than
-- the five-minute floor. The floor is a cost and abuse control, so it lives here
-- as well as in the API: an agent cannot create a ten-second refresh by any path.
ALTER TABLE "dashboard_data_sources"
  ADD CONSTRAINT "dashboard_data_sources_interval_check" CHECK (
    (refresh_mode = 'manual' AND interval_minutes IS NULL)
    OR (refresh_mode = 'interval' AND interval_minutes >= 5 AND interval_minutes <= 1440)
  );
