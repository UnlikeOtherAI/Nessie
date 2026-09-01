-- DeepSignal authenticates Nessie as an application independently from the
-- acting UOA user. Replace the transitional per-user OAuth bearer with one
-- deployment-owned, DeepSignal-issued Nessie app-key reference. Short-lived
-- UOA delegation and X-Nessie-Context headers are attached at dispatch.

UPDATE "mcp_catalog_entries" "catalog"
SET
  "description" = 'DeepSignal MCP server for app-key-authenticated Nessie conversations, history, and insight actions with independently signed UOA actor context.',
  "auth_method" = 'bearer'::"McpCatalogAuthMethod",
  "auth_config" = jsonb_build_object('method', 'bearer'),
  "default_transport_config" = jsonb_build_object(
    'transport',
    'http',
    'url',
    'https://api.deepsignal.live/mcp'
  ),
  "updated_at" = CURRENT_TIMESTAMP
WHERE "catalog"."id" IN (
    SELECT "product"."mcp_catalog_entry_id"
    FROM "integrated_products" "product"
    WHERE "product"."slug" = 'deepsignal'
  )
  AND "catalog"."name" = 'deepsignal'
  AND "catalog"."visibility" = 'public';

UPDATE "integrated_products"
SET
  "auth_mode" = 'uoa_sso'::"IntegratedProductAuthMode",
  "setup_hint" = 'Activate DeepSignal using your existing Nessie UOA identity. Nessie authenticates with its dedicated DeepSignal app key and delegates your active workspace per request.',
  "health_status" = 'setup_required'::"IntegratedProductHealthStatus",
  "health_detail" = 'Requires DEEPSIGNAL_MCP_APP_KEY and configured UOA signing/client credentials.',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'deepsignal';

WITH "deepsignal_instances" AS (
  SELECT "instance"."id"
  FROM "mcp_server_instances" "instance"
  JOIN "mcp_catalog_entries" "catalog"
    ON "catalog"."id" = "instance"."catalog_entry_id"
  JOIN "integrated_products" "product"
    ON "product"."mcp_catalog_entry_id" = "catalog"."id"
   AND "product"."slug" = 'deepsignal'
  WHERE "catalog"."name" = 'deepsignal'
    AND "catalog"."visibility" = 'public'
),
"deepsignal_secret_refs" AS (
  SELECT "instance"."credential_ref" AS "ref"
  FROM "mcp_server_instances" "instance"
  WHERE "instance"."id" IN (SELECT "id" FROM "deepsignal_instances")
    AND "instance"."credential_ref" IS NOT NULL
    AND "instance"."credential_ref" <> 'DEEPSIGNAL_MCP_APP_KEY'
  UNION
  SELECT "override"."credential_ref" AS "ref"
  FROM "mcp_server_credential_overrides" "override"
  WHERE "override"."instance_id" IN (SELECT "id" FROM "deepsignal_instances")
)
DELETE FROM "mcp_oauth_secret" "secret"
USING "deepsignal_secret_refs" "owned"
WHERE "secret"."ref" = "owned"."ref"
  AND NOT EXISTS (
    SELECT 1
    FROM "mcp_server_instances" "other_instance"
    WHERE "other_instance"."credential_ref" = "owned"."ref"
      AND "other_instance"."id" NOT IN (SELECT "id" FROM "deepsignal_instances")
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "mcp_server_credential_overrides" "other_override"
    WHERE "other_override"."credential_ref" = "owned"."ref"
      AND "other_override"."instance_id" NOT IN (SELECT "id" FROM "deepsignal_instances")
  );

DELETE FROM "mcp_oauth_states"
WHERE "payload" ->> 'instanceId' IN (
  SELECT "instance"."id"::text
  FROM "mcp_server_instances" "instance"
  JOIN "mcp_catalog_entries" "catalog"
    ON "catalog"."id" = "instance"."catalog_entry_id"
  JOIN "integrated_products" "product"
    ON "product"."mcp_catalog_entry_id" = "catalog"."id"
   AND "product"."slug" = 'deepsignal'
  WHERE "catalog"."name" = 'deepsignal'
    AND "catalog"."visibility" = 'public'
);

DELETE FROM "mcp_server_credential_overrides" "override"
WHERE "override"."instance_id" IN (
  SELECT "instance"."id"
  FROM "mcp_server_instances" "instance"
  JOIN "mcp_catalog_entries" "catalog"
    ON "catalog"."id" = "instance"."catalog_entry_id"
  JOIN "integrated_products" "product"
    ON "product"."mcp_catalog_entry_id" = "catalog"."id"
   AND "product"."slug" = 'deepsignal'
  WHERE "catalog"."name" = 'deepsignal'
    AND "catalog"."visibility" = 'public'
);

DELETE FROM "tool_registry_entries" "tool"
WHERE "tool"."mcp_instance_id" IN (
  SELECT "instance"."id"
  FROM "mcp_server_instances" "instance"
  JOIN "mcp_catalog_entries" "catalog"
    ON "catalog"."id" = "instance"."catalog_entry_id"
  JOIN "integrated_products" "product"
    ON "product"."mcp_catalog_entry_id" = "catalog"."id"
   AND "product"."slug" = 'deepsignal'
  WHERE "catalog"."name" = 'deepsignal'
    AND "catalog"."visibility" = 'public'
);

UPDATE "mcp_server_instances" "instance"
SET
  "credential_ref" = 'DEEPSIGNAL_MCP_APP_KEY',
  "transport_config" = '{}'::jsonb,
  "discovered_tools" = '[]'::jsonb,
  "lifecycle_state" = 'active'::"McpServerLifecycleState",
  "health_last_checked_at" = NULL,
  "health_failure_count" = 0,
  "last_error" = NULL,
  "updated_at" = CURRENT_TIMESTAMP
FROM "mcp_catalog_entries" "catalog",
  "integrated_products" "product"
WHERE "catalog"."id" = "instance"."catalog_entry_id"
  AND "product"."mcp_catalog_entry_id" = "catalog"."id"
  AND "product"."slug" = 'deepsignal'
  AND "catalog"."name" = 'deepsignal'
  AND "catalog"."visibility" = 'public';

-- OAuth activation previously left otherwise valid UOA links in needs_auth.
-- Promote only complete links; never invent a missing subject or workspace.
UPDATE "product_account_links"
SET
  "status" = 'linked'::"ProductAccountLinkStatus",
  "last_verified_at" = CURRENT_TIMESTAMP,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "product_slug" = 'deepsignal'
  AND "status" = 'needs_auth'::"ProductAccountLinkStatus"
  AND "uoa_sub" IS NOT NULL
  AND "active_org_id" IS NOT NULL
  AND "active_team_id" IS NOT NULL;
