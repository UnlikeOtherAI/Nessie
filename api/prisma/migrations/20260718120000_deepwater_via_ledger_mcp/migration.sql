-- DeepWater research is metered and authorized by Ledger. Replace the original
-- direct-provider OAuth catalog contract with Ledger's bearer-authenticated MCP
-- adapter contract. The endpoint remains environment-resolved at activation;
-- no provider URL or shared credential is persisted here.

UPDATE "mcp_catalog_entries" "catalog"
SET
  "description" = 'Ledger-metered Deep Water research MCP adapter for starting jobs, polling status, reading reports, listing jobs, and cancelling jobs.',
  "auth_method" = 'bearer'::"McpCatalogAuthMethod",
  "auth_config" = jsonb_build_object('method', 'bearer'),
  "default_transport_config" = jsonb_build_object(
    'urlEnv',
    'LEDGER_DEEPWATER_MCP_URL',
    'setup',
    'Set the Ledger DeepWater MCP adapter URL. Each caller must store a dedicated Ledger ProxyToken as their encrypted user credential override.'
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
  "summary" = 'Ledger-metered Deep Water research jobs, sources, reports, and booked rate-card charges.',
  "auth_mode" = 'api_key'::"IntegratedProductAuthMode",
  "setup_hint" = 'Enable Deep Water for the team, then store your dedicated Ledger ProxyToken securely on the generated connector.',
  "health_status" = 'setup_required'::"IntegratedProductHealthStatus",
  "health_detail" = 'Requires LEDGER_DEEPWATER_MCP_URL and a per-user Ledger ProxyToken.',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'deep-water';

-- Existing instances may still contain a direct-provider transport and OAuth
-- credentials. Fail closed across the contract transition: disable
-- their projected tools, clear all transports/credentials/discovery state, and
-- require the owner to re-enable the team after the Ledger endpoint is set.
UPDATE "tool_registry_entries" "tool"
SET
  "status" = 'disabled'::"ToolRegistryEntryStatus",
  "metadata" = COALESCE("tool"."metadata", '{}'::jsonb)
    || jsonb_build_object(
      'requiresExplicitGrant',
      true,
      'disabledReason',
      'DeepWater now routes through Ledger; re-enable the team and explicitly grant the new Ledger-backed tools.'
    ),
  "updated_at" = CURRENT_TIMESTAMP
WHERE "tool"."mcp_instance_id" IN (
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

-- OAuth/user-secret refs are uniquely minted in normal operation. Remove the
-- encrypted rows owned only by DeepWater before clearing their references, but
-- retain a ref if any non-DeepWater instance/override also points at it (manual
-- credentialRef reuse is possible through the generic admin surface).
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
  "credential_ref" = NULL,
  "transport_config" = '{}'::jsonb,
  "discovered_tools" = '[]'::jsonb,
  "lifecycle_state" = 'pending_setup'::"McpServerLifecycleState",
  "health_last_checked_at" = NULL,
  "health_failure_count" = 0,
  "last_error" = 'DeepWater now routes through Ledger. Re-enable the team after configuring LEDGER_DEEPWATER_MCP_URL, then store a per-user Ledger ProxyToken.',
  "updated_at" = CURRENT_TIMESTAMP
FROM "mcp_catalog_entries" "catalog",
  "integrated_products" "product"
WHERE "catalog"."id" = "instance"."catalog_entry_id"
  AND "product"."mcp_catalog_entry_id" = "catalog"."id"
  AND "product"."slug" = 'deep-water'
  AND "catalog"."name" = 'deep-water'
  AND "catalog"."visibility" = 'public';

UPDATE "product_team_enablements"
SET
  "enabled" = false,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "product_slug" = 'deep-water'
  AND "enabled" = true
  AND EXISTS (
    SELECT 1
    FROM "integrated_products" "product"
    JOIN "mcp_catalog_entries" "catalog"
      ON "product"."mcp_catalog_entry_id" = "catalog"."id"
    WHERE "product"."slug" = 'deep-water'
      AND "catalog"."name" = 'deep-water'
      AND "catalog"."visibility" = 'public'
  );
