-- First-party ESC products that expose MCP should also be installable from the
-- shared MCP catalog. BuildMe remains link-only until it publishes a board API
-- and MCP contract.

WITH "first_party_catalog_entries" (
  "id",
  "name",
  "label",
  "description",
  "protocol",
  "auth_method",
  "auth_config",
  "default_transport_config",
  "vendor",
  "source_url",
  "product_slug"
) AS (
  VALUES
    (
      '8f3a5a00-0e64-4d10-a517-0d0b69c1d111'::UUID,
      'deep-water',
      'Deep Water',
      'Deep Water research MCP server for creating research runs, polling status, reading sources, importing reports, and reporting usage.',
      'http'::"McpCatalogProtocol",
      'oauth2'::"McpCatalogAuthMethod",
      jsonb_build_object(
        'method',
        'oauth2',
        'scopes',
        jsonb_build_array('research:create', 'research:read', 'usage:read')
      ),
      jsonb_build_object(
        'urlEnv',
        'DEEP_WATER_MCP_URL',
        'setup',
        'Set the protected Deep Water MCP endpoint URL when installing this connector.'
      ),
      'UnlikeOtherAI',
      NULL,
      'deep-water'
    ),
    (
      '8f3a5a00-0e64-4d10-a517-0d0b69c1d112'::UUID,
      'deeptest',
      'DeepTest',
      'DeepTest MCP server for local-first security review requests, review status, and share-safe report retrieval.',
      'http'::"McpCatalogProtocol",
      'none'::"McpCatalogAuthMethod",
      jsonb_build_object('method', 'none'),
      jsonb_build_object(
        'urlEnv',
        'DEEPTEST_MCP_URL',
        'localOnly',
        true,
        'setup',
        'Set a DeepTest local runner or remote-runner MCP endpoint when installing this connector.'
      ),
      'UnlikeOtherAI',
      'https://deeptest.live',
      'deeptest'
    )
),
"upserted_catalog_entries" AS (
  INSERT INTO "mcp_catalog_entries" (
    "id",
    "organization_id",
    "name",
    "label",
    "description",
    "protocol",
    "auth_method",
    "auth_config",
    "default_transport_config",
    "vendor",
    "source_url",
    "status",
    "visibility",
    "owner_user_id",
    "created_by",
    "created_at",
    "updated_at"
  )
  SELECT
    "entry"."id",
    NULL,
    "entry"."name",
    "entry"."label",
    "entry"."description",
    "entry"."protocol",
    "entry"."auth_method",
    "entry"."auth_config",
    "entry"."default_transport_config",
    "entry"."vendor",
    "entry"."source_url",
    'published'::"McpCatalogStatus",
    'public'::"McpCatalogVisibility",
    NULL,
    '00000000-0000-0000-0000-000000000000'::UUID,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM "first_party_catalog_entries" "entry"
  WHERE NOT EXISTS (
    SELECT 1
    FROM "mcp_catalog_entries" "existing"
    WHERE "existing"."name" = "entry"."name"
      AND "existing"."visibility" = 'public'
  )
  RETURNING "id", "name"
)
UPDATE "mcp_catalog_entries" "catalog"
SET
  "label" = "entry"."label",
  "description" = "entry"."description",
  "protocol" = "entry"."protocol",
  "auth_method" = "entry"."auth_method",
  "auth_config" = "entry"."auth_config",
  "default_transport_config" = "entry"."default_transport_config",
  "vendor" = "entry"."vendor",
  "source_url" = "entry"."source_url",
  "status" = 'published'::"McpCatalogStatus",
  "visibility" = 'public'::"McpCatalogVisibility",
  "owner_user_id" = NULL,
  "updated_at" = CURRENT_TIMESTAMP
FROM "first_party_catalog_entries" "entry"
WHERE "catalog"."name" = "entry"."name"
  AND "catalog"."visibility" = 'public';

UPDATE "integrated_products" "product"
SET
  "mcp_catalog_entry_id" = "catalog"."id",
  "updated_at" = CURRENT_TIMESTAMP
FROM "mcp_catalog_entries" "catalog"
WHERE "product"."slug" = "catalog"."name"
  AND "catalog"."visibility" = 'public'
  AND "catalog"."name" IN ('deep-water', 'deeptest');
