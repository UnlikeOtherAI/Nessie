-- A folder becomes a real page kind.
--
-- Postgres refuses to USE a new enum value in the same transaction that added
-- it, and Prisma runs each migration file in its own transaction, so the
-- backfill that writes 'folder' is the next migration file, not this one.
ALTER TYPE "KnowledgePageKind" ADD VALUE IF NOT EXISTS 'folder';
