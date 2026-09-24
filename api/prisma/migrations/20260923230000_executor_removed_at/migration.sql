-- A deleted executor keeps its row, because run bindings, conversation leases
-- and the audit trail point at it, and is hidden from the people-facing reads.
-- Deleting always revokes the executor as well, so the existing revoked-status
-- guards keep refusing its daemon without reading this column.
--
-- Additive only.

-- AlterTable
ALTER TABLE "executors" ADD COLUMN "removed_at" TIMESTAMP(3);
