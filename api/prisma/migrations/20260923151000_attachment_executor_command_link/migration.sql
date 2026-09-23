-- Executor command images are FileService attachments
-- (docs/plans/2026-09-22-executor-local-apps/screenshots.md §2).
--
-- Additive only: three nullable columns on `attachments` and one index, so it
-- is compatible with the previous release while it still serves.
--
-- `executor_command_id` is an app-enforced pointer, no FK — the `message_id`
-- precedent: the file service owns the row's lifecycle, not the command.
-- `content_digest` and `content_byte_length` describe the bytes as the daemon
-- uploaded them, before metadata stripping re-encoded them.

ALTER TABLE "attachments"
    ADD COLUMN "executor_command_id" UUID,
    ADD COLUMN "content_digest" TEXT,
    ADD COLUMN "content_byte_length" INTEGER;

-- One command's upload of one image is one attachment: a re-upload after a
-- daemon restart names the same row. It also serves every per-command lookup.
CREATE UNIQUE INDEX "attachments_executor_command_id_content_digest_key"
    ON "attachments"("executor_command_id", "content_digest");

-- The three are set together or not at all. Prisma cannot express this, so it
-- lives here, the way the lease table's constraints do.
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_executor_command_content"
    CHECK (
        ("executor_command_id" IS NULL AND "content_digest" IS NULL AND "content_byte_length" IS NULL)
        OR ("executor_command_id" IS NOT NULL AND "content_digest" IS NOT NULL AND "content_byte_length" > 0)
    );
