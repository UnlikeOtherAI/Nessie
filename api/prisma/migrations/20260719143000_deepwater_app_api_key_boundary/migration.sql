-- Clarify the already-deployed DeepWater operator copy without changing its
-- bearer transport contract. LEDGER_PROXY_TOKEN is the secret reference for
-- Nessie's dedicated, product-bound Ledger app API key. Signed caller identity
-- and webhook callback authentication remain separate security boundaries.

UPDATE "mcp_catalog_entries" "catalog"
SET
  "default_transport_config" = jsonb_set(
    COALESCE("catalog"."default_transport_config", '{}'::jsonb),
    '{setup}',
    to_jsonb(
      'Set the Ledger DeepWater MCP adapter URL and Nessie''s dedicated Ledger app API key in LEDGER_PROXY_TOKEN. Signed SSO caller identity is supplied independently; never reuse webhook signing secrets as this key.'::text
    ),
    true
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
  "setup_hint" = 'Enable Deep Water for the team after configuring Nessie''s dedicated Ledger app API key. Signed SSO identity assigns each request and charge to its user, organization, and team; webhook signing secrets stay separate.',
  "health_detail" = 'Requires LEDGER_DEEPWATER_MCP_URL, Nessie''s product-bound Ledger app API key in LEDGER_PROXY_TOKEN, and configured UOA signing credentials.',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" = 'deep-water';
