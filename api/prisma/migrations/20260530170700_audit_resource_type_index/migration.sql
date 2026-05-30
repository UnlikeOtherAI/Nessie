-- listAuditLog (audit.ts) filters by resource_type and orders by created_at
-- DESC. The existing (organization_id, resource_type, resource_id) index cannot
-- satisfy that ordering, so the query falls back to a scan + sort. Add an index
-- leading with (organization_id, resource_type) and trailing created_at DESC.
--
-- PRODUCTION: use CREATE INDEX CONCURRENTLY here (cannot run inside Prisma's
-- migration transaction). Flagged for the deploy runbook.
CREATE INDEX "audit_logs_organization_id_resource_type_created_at_idx"
  ON "audit_logs" ("organization_id", "resource_type", "created_at" DESC);
