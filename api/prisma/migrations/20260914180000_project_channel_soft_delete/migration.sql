-- Projects and channels are soft-deleted (docs/standards/team-model.md →
-- "Deleting a project or a channel"). The rows and everything under them stay
-- intact for a future restore; readers filter `deleted_at IS NULL`.
--
-- A deleted channel is also stamped `archived_at`, so the existing partial
-- unique index `channels_project_slug_standard_key` (WHERE archived_at IS NULL)
-- already releases its name; no index change is needed here.
--
-- `projects.description` is the one-sentence purpose a person outside the
-- project may read alongside its name and members.
--
-- Additive and nullable only: replicas still running the previous build ignore
-- the new columns during a blue-green swap.

ALTER TABLE "projects" ADD COLUMN "description" TEXT;
ALTER TABLE "projects" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "channels" ADD COLUMN "deleted_at" TIMESTAMP(3);
