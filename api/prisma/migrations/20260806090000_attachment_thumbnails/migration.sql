-- Attachment thumbnails: a small WebP derivative stored next to the original
-- so chat feeds paint previews without transferring full-resolution bytes.
--
-- Additive and nullable only. `attachments` is a hot, potentially large table
-- and every added column is NULL-able with no DEFAULT, so PostgreSQL rewrites
-- no rows and takes only a brief ACCESS EXCLUSIVE lock for the catalog update.
-- Existing rows are deliberately left with NULL thumbnails: there is no
-- backfill, and every reader falls back to the original bytes.

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN "thumbnail_key" TEXT;
ALTER TABLE "attachments" ADD COLUMN "thumbnail_mime" TEXT;
ALTER TABLE "attachments" ADD COLUMN "thumbnail_size_bytes" BIGINT;
ALTER TABLE "attachments" ADD COLUMN "thumbnail_width" INTEGER;
ALTER TABLE "attachments" ADD COLUMN "thumbnail_height" INTEGER;
-- pending | ready | unavailable — only the async (worker) path uses `pending`.
ALTER TABLE "attachments" ADD COLUMN "thumbnail_status" TEXT;
