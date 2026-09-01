-- Preserve the effective Nessie user as its own attribution dimension. Actor
-- may be an agent/service even when a human is the effective caller.
ALTER TABLE "token_ledger_events"
  ADD COLUMN "user_id" uuid;

ALTER TABLE "connector_usage_events"
  ADD COLUMN "user_id" uuid;

CREATE INDEX "token_ledger_events_organization_id_user_id_occurred_at_idx"
  ON "token_ledger_events" ("organization_id", "user_id", "occurred_at" DESC);

CREATE INDEX "connector_usage_events_organization_id_user_id_occurred_at_idx"
  ON "connector_usage_events" ("organization_id", "user_id", "occurred_at" DESC);

-- DeepWater now uses a single Nessie-owned Ledger ProxyToken for transport
-- authentication. Per-user identity is carried independently in signed UOA and
-- Nessie context JWTs, so old personal overrides must not shadow the service
-- credential or retain stale encrypted secrets.
WITH "deep_water_instances" AS (
  SELECT "instance"."id"
  FROM "mcp_server_instances" "instance"
  JOIN "mcp_catalog_entries" "catalog"
    ON "catalog"."id" = "instance"."catalog_entry_id"
  JOIN "integrated_products" "product"
    ON "product"."mcp_catalog_entry_id" = "catalog"."id"
   AND "product"."slug" = 'deep-water'
  WHERE "catalog"."name" = 'deep-water'
    AND "catalog"."visibility" = 'public'
),
"deep_water_secret_refs" AS (
  SELECT "instance"."credential_ref" AS "ref"
  FROM "mcp_server_instances" "instance"
  WHERE "instance"."id" IN (SELECT "id" FROM "deep_water_instances")
    AND "instance"."credential_ref" IS NOT NULL
    AND "instance"."credential_ref" <> 'LEDGER_PROXY_TOKEN'
  UNION
  SELECT "override"."credential_ref" AS "ref"
  FROM "mcp_server_credential_overrides" "override"
  WHERE "override"."instance_id" IN (SELECT "id" FROM "deep_water_instances")
)
DELETE FROM "mcp_oauth_secret" "secret"
USING "deep_water_secret_refs" "owned"
WHERE "secret"."ref" = "owned"."ref"
  AND NOT EXISTS (
    SELECT 1
    FROM "mcp_server_instances" "other_instance"
    WHERE "other_instance"."credential_ref" = "owned"."ref"
      AND "other_instance"."id" NOT IN (SELECT "id" FROM "deep_water_instances")
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "mcp_server_credential_overrides" "other_override"
    WHERE "other_override"."credential_ref" = "owned"."ref"
      AND "other_override"."instance_id" NOT IN (SELECT "id" FROM "deep_water_instances")
  );

DELETE FROM "mcp_server_credential_overrides" "override"
WHERE "override"."instance_id" IN (
  SELECT "instance"."id"
  FROM "mcp_server_instances" "instance"
  JOIN "mcp_catalog_entries" "catalog"
    ON "catalog"."id" = "instance"."catalog_entry_id"
  JOIN "integrated_products" "product"
    ON "product"."mcp_catalog_entry_id" = "catalog"."id"
   AND "product"."slug" = 'deep-water'
  WHERE "catalog"."name" = 'deep-water'
    AND "catalog"."visibility" = 'public'
);

UPDATE "mcp_server_instances" "instance"
SET
  "credential_ref" = 'LEDGER_PROXY_TOKEN',
  "updated_at" = CURRENT_TIMESTAMP
FROM "mcp_catalog_entries" "catalog",
  "integrated_products" "product"
WHERE "catalog"."id" = "instance"."catalog_entry_id"
  AND "product"."mcp_catalog_entry_id" = "catalog"."id"
  AND "product"."slug" = 'deep-water'
  AND "catalog"."name" = 'deep-water'
  AND "catalog"."visibility" = 'public';

UPDATE "mcp_catalog_entries" "catalog"
SET
  "default_transport_config" = jsonb_build_object(
    'urlEnv',
    'LEDGER_DEEPWATER_MCP_URL',
    'setup',
    'Set the Ledger DeepWater MCP adapter URL and the shared LEDGER_PROXY_TOKEN. Caller identity is supplied by signed Nessie and UOA headers.'
  ),
  "updated_at" = CURRENT_TIMESTAMP
WHERE "catalog"."id" IN (
  SELECT "product"."mcp_catalog_entry_id"
  FROM "integrated_products" "product"
  WHERE "product"."slug" = 'deep-water'
)
  AND "catalog"."name" = 'deep-water'
  AND "catalog"."visibility" = 'public';

UPDATE "integrated_products"
SET
  -- Product identity is UOA SSO even though the linked MCP transport uses a
  -- shared Ledger bearer. Keeping those two auth layers separate ensures the
  -- first UOA login creates the per-user DeepWater account link.
  "auth_mode" = 'uoa_sso'::"IntegratedProductAuthMode",
  "setup_hint" = 'Enable Deep Water for the team. Nessie authenticates to Ledger with its shared service token and delegates the signed SSO user automatically.',
  "health_detail" = 'Requires LEDGER_DEEPWATER_MCP_URL, LEDGER_PROXY_TOKEN, and configured UOA signing credentials.',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'deep-water';
