-- Disclosure basis ledger.
--
-- `run_basis_scopes` is the primary provenance record: the scoped sources a run
-- actually consumed that are NOT implied by the destination's own scope chain.
-- Empty for the overwhelming majority of runs. Everything a run materialises —
-- messages, thinking chunks, tool calls, checkpoints, plan artifacts — is
-- governed by this one ledger. `RunCheckpoint.run_id` is unique, so checkpoints
-- inherit their run's basis without a table of their own.
--
-- `message_basis_scopes` is a denormalised copy carried on the message so the
-- read predicate can filter a conversation window with one anti-join rather than
-- joining back through runs.
--
-- Neither table creates an index on `messages` or `runs` themselves (the index
-- belongs to the child table), so the non-CONCURRENTLY migration lint warning
-- does not apply.

CREATE TABLE "run_basis_scopes" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id"          UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "scope_type"      TEXT NOT NULL,
  "scope_id"        UUID NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT now(),

  CONSTRAINT "run_basis_scopes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_basis_scopes_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "run_basis_scopes_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "run_basis_scopes_run_scope_key"
  ON "run_basis_scopes"("run_id", "scope_type", "scope_id");
CREATE INDEX "run_basis_scopes_org_idx"
  ON "run_basis_scopes"("organization_id");

CREATE TABLE "message_basis_scopes" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "message_id"      UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "scope_type"      TEXT NOT NULL,
  "scope_id"        UUID NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT now(),

  CONSTRAINT "message_basis_scopes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "message_basis_scopes_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "message_basis_scopes_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "message_basis_scopes_message_scope_key"
  ON "message_basis_scopes"("message_id", "scope_type", "scope_id");
CREATE INDEX "message_basis_scopes_org_idx"
  ON "message_basis_scopes"("organization_id");
