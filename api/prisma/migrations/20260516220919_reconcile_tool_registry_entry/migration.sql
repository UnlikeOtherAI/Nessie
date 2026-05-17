-- Reconcile ToolRegistryEntry with tool-registry-spec.md §3.1.
--
-- Adds the columns the spec lists but the model is missing
-- (overview, instructions, baseSearchTerms, allowSearchTerms, basePrompt,
-- commonPrompt, defaultConfig, searchableText, owner). All additions are
-- non-NULL with safe defaults so existing rows backfill automatically.
--
-- Tightens the uniqueness story: the legacy (scope_key, tool_id) unique was
-- cross-organization, which would have prevented two different orgs from
-- registering the same toolId under the same scopeKey. Spec §3.1 wants the
-- uniqueness scoped to organizationId. Drop the legacy unique and add
-- (organization_id, scope_key, tool_id). Existing data satisfies the new
-- constraint because the old constraint was strictly stricter.
--
-- Also adds the GIN tags index and updatedAt index called for by the §5
-- discovery query patterns.

-- AlterTable: add spec §3.1 columns (additive, defaulted, backfills in place)
ALTER TABLE "tool_registry_entries"
  ADD COLUMN "overview"           TEXT  NOT NULL DEFAULT '',
  ADD COLUMN "instructions"       TEXT  NOT NULL DEFAULT '',
  ADD COLUMN "base_search_terms"  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "allow_search_terms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "base_prompt"        JSONB NOT NULL DEFAULT '{"content": "", "mergeMode": "append"}',
  ADD COLUMN "common_prompt"      JSONB,
  ADD COLUMN "default_config"     JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "searchable_text"    TEXT  NOT NULL DEFAULT '',
  ADD COLUMN "owner"              TEXT  NOT NULL DEFAULT 'system';

-- DropIndex: legacy cross-org unique (replaced by org-scoped variant below)
DROP INDEX "tool_registry_entries_scope_key_tool_id_key";

-- The three CREATE INDEX statements below intentionally omit `CONCURRENTLY`.
-- Nessie has no live production load yet, so a brief table-level lock during
-- a fresh-DB migration is acceptable. Once the system carries live traffic
-- (multi-tenant org workloads writing into tool_registry_entries), each of
-- these must be rebuilt with `CREATE INDEX CONCURRENTLY` to avoid blocking
-- writers. Tracked in the MCP-universal-connector follow-up plan as a
-- deferred operational hardening, not a spec-equivalent implementation.

-- CreateIndex: org-scoped uniqueness per spec §3.1
CREATE UNIQUE INDEX "tool_registry_entries_org_scope_tool_key"
  ON "tool_registry_entries" ("organization_id", "scope_key", "tool_id");

-- CreateIndex: GIN tags index for spec §5 discovery filter.
-- DEFERRED PERF OPTIMIZATION (NOT a spec-equivalent implementation):
-- The `btree_gin` extension is intentionally not enabled here, so this GIN
-- index covers `tags` alone. For org-scoped tag filters the planner falls
-- back to a heuristic bitmap-AND between this index and the existing
-- `organization_id` composite btree indexes. That heuristic is good enough
-- for current single-tenant volumes but may degrade at scale (high tag
-- cardinality + large per-org row counts can flip the planner toward a
-- seq-scan). When this becomes load-bearing, enable `btree_gin` and rebuild
-- this index as a composite `(organization_id, tags)` GIN. Tracked in the
-- MCP-universal-connector follow-up plan.
CREATE INDEX "tool_registry_entries_tags_idx"
  ON "tool_registry_entries" USING GIN ("tags");

-- CreateIndex: updatedAt ordering for spec §5.1 default sort
CREATE INDEX "tool_registry_entries_updated_at_idx"
  ON "tool_registry_entries" ("updated_at");
