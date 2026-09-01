-- ProductAccountLink is keyed to IntegratedProduct, including the first-party
-- Nessie identity anchor used to validate renewable UOA sessions. Keep this row
-- out of the customer-facing Integrations catalog; it exists only so the stable
-- per-user Nessie subject/credential epoch has a referentially sound owner.
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
) VALUES (
  '8f3a5a00-0e64-4d10-a517-0d0b69c1d100',
  'nessie',
  'Nessie',
  'Internal first-party UOA account-link identity anchor.',
  'project_management',
  'https://app.nessie.works',
  'https://api.nessie.works',
  'uoa_sso',
  'native',
  'first-party/nessie',
  'healthy',
  ARRAY['uoa_account_link']::TEXT[],
  NULL,
  0,
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
