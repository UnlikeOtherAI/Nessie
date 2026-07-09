-- DeepSignal: the fourth ESC product — a per-user activatable external agent
-- (objective-first decision intelligence / autonomous signal monitoring) hosted
-- at its own URL and reached directly over MCP. Registers the product row, a
-- first-party public/published MCP catalog entry (dynamic OAuth, no static
-- client), and back-links the two. Idempotent, mirroring the deep-water /
-- deeptest seed migrations.

INSERT INTO "integrated_products" (
  "id",
  "slug",
  "name",
  "summary",
  "category",
  "launch_url",
  "api_base_url",
  "auth_mode",
  "default_install_state",
  "plugin_manifest_ref",
  "health_status",
  "capabilities",
  "setup_hint",
  "sort_order",
  "created_at",
  "updated_at"
) VALUES
  (
    '8f3a5a00-0e64-4d10-a517-0d0b69c1d104',
    'deepsignal',
    'DeepSignal',
    'Objective-first decision intelligence: autonomous signal monitoring that surfaces the opportunities and risks that matter.',
    'research',
    'https://deepsignal.live',
    NULL,
    'oauth_mcp',
    'native',
    'first-party/deepsignal',
    'setup_required',
    ARRAY['external_agent', 'signal_monitoring', 'insight_digest', 'conversation']::TEXT[],
    'Activate DeepSignal for yourself and sign in with your account to open a private DeepSignal conversation.',
    15,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "summary" = EXCLUDED."summary",
  "category" = EXCLUDED."category",
  "launch_url" = EXCLUDED."launch_url",
  "api_base_url" = EXCLUDED."api_base_url",
  "auth_mode" = EXCLUDED."auth_mode",
  "default_install_state" = EXCLUDED."default_install_state",
  "plugin_manifest_ref" = EXCLUDED."plugin_manifest_ref",
  "health_status" = EXCLUDED."health_status",
  "capabilities" = EXCLUDED."capabilities",
  "setup_hint" = EXCLUDED."setup_hint",
  "sort_order" = EXCLUDED."sort_order",
  "updated_at" = CURRENT_TIMESTAMP;

-- First-party public catalog entry for the DeepSignal MCP endpoint. Dynamic
-- OAuth: `method: oauth2` with no static client triggers metadata discovery +
-- Dynamic Client Registration at connect time (per the MCP authorization spec).
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
  "source_url"
) AS (
  VALUES
    (
      '8f3a5a00-0e64-4d10-a517-0d0b69c1d114'::UUID,
      'deepsignal',
      'DeepSignal',
      'DeepSignal MCP server for the per-user external conversation surface: chat, conversation history, insight digest, and research references.',
      'http'::"McpCatalogProtocol",
      'oauth2'::"McpCatalogAuthMethod",
      jsonb_build_object('method', 'oauth2'),
      jsonb_build_object('transport', 'http', 'url', 'https://api.deepsignal.live/mcp'),
      'DeepSignal',
      'https://deepsignal.live'
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
  AND "catalog"."name" = 'deepsignal';
