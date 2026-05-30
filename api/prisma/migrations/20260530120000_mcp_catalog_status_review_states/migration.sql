-- MCP App Store: add the public-review lifecycle states to the catalog status
-- enum. Isolated in its own migration because PostgreSQL cannot add an enum
-- value and use it within the same transaction.
-- Spec: docs/plans/2026-05-30-mcp-store-publishing-approval.md

-- AlterEnum
ALTER TYPE "McpCatalogStatus" ADD VALUE 'pending_approval' AFTER 'draft';
ALTER TYPE "McpCatalogStatus" ADD VALUE 'rejected' AFTER 'published';
