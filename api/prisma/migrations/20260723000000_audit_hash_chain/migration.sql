-- Tamper-evident audit trail: link every AuditLog row into a per-organization
-- SHA-256 hash chain. `entry_hash = sha256(canonicalJson(fields, prev_hash))`,
-- where `prev_hash` is the previous chained entry's `entry_hash` for the same
-- organization (null for the genesis entry). Both columns are nullable: existing
-- rows are a pre-chain epoch and are ignored by the chain tip-read and verify
-- walk. No backfill — the chain starts at the first new row per organization.
-- See @nessie/db audit-chain.ts (writeAuditEntry / verifyAuditChain).

ALTER TABLE "audit_logs" ADD COLUMN "prev_hash" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "entry_hash" TEXT;
