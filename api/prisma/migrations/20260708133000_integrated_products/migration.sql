CREATE TYPE "IntegratedProductCategory" AS ENUM (
  'research',
  'security',
  'development',
  'project_management'
);

CREATE TYPE "IntegratedProductAuthMode" AS ENUM (
  'uoa_sso',
  'api_key',
  'oauth_mcp',
  'local_mcp'
);

CREATE TYPE "IntegratedProductInstallState" AS ENUM (
  'link_only',
  'installable',
  'native'
);

CREATE TYPE "IntegratedProductHealthStatus" AS ENUM (
  'unknown',
  'healthy',
  'degraded',
  'unreachable',
  'setup_required'
);

CREATE TYPE "ProductAccountLinkStatus" AS ENUM (
  'linked',
  'needs_auth',
  'revoked',
  'error'
);

CREATE TABLE "integrated_products" (
  "id" UUID NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "category" "IntegratedProductCategory" NOT NULL,
  "launch_url" TEXT,
  "api_base_url" TEXT,
  "auth_mode" "IntegratedProductAuthMode" NOT NULL,
  "default_install_state" "IntegratedProductInstallState" NOT NULL,
  "mcp_catalog_entry_id" UUID,
  "plugin_manifest_ref" TEXT,
  "health_status" "IntegratedProductHealthStatus" NOT NULL DEFAULT 'unknown',
  "health_detail" TEXT,
  "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "setup_hint" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 100,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "integrated_products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_account_links" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "product_slug" TEXT NOT NULL,
  "uoa_sub" TEXT,
  "external_account_id" TEXT,
  "active_org_id" TEXT,
  "active_team_id" TEXT,
  "status" "ProductAccountLinkStatus" NOT NULL,
  "last_verified_at" TIMESTAMP(3),
  "metadata_json" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "product_account_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integrated_products_slug_key"
  ON "integrated_products"("slug");
CREATE INDEX "integrated_products_category_idx"
  ON "integrated_products"("category");
CREATE INDEX "integrated_products_health_status_idx"
  ON "integrated_products"("health_status");
CREATE UNIQUE INDEX "product_account_links_organization_id_user_id_product_slug_key"
  ON "product_account_links"("organization_id", "user_id", "product_slug");
CREATE INDEX "product_account_links_product_slug_status_idx"
  ON "product_account_links"("product_slug", "status");

ALTER TABLE "integrated_products"
  ADD CONSTRAINT "integrated_products_mcp_catalog_entry_id_fkey"
  FOREIGN KEY ("mcp_catalog_entry_id")
  REFERENCES "mcp_catalog_entries"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_account_links"
  ADD CONSTRAINT "product_account_links_organization_id_fkey"
  FOREIGN KEY ("organization_id")
  REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_account_links"
  ADD CONSTRAINT "product_account_links_product_slug_fkey"
  FOREIGN KEY ("product_slug")
  REFERENCES "integrated_products"("slug")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_account_links"
  ADD CONSTRAINT "product_account_links_user_id_fkey"
  FOREIGN KEY ("user_id")
  REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

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
    '8f3a5a00-0e64-4d10-a517-0d0b69c1d101',
    'deep-water',
    'Deep Water',
    'Deep research runs, sources, report artifacts, and research spend.',
    'research',
    NULL,
    NULL,
    'oauth_mcp',
    'native',
    'first-party/deep-water',
    'setup_required',
    ARRAY['deep_research', 'sources', 'usage_cost', 'knowledge_import']::TEXT[],
    'Connect Deep Water through OAuth MCP or a product API credential before native runs are enabled.',
    10,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    '8f3a5a00-0e64-4d10-a517-0d0b69c1d102',
    'deeptest',
    'DeepTest',
    'Security review, local MCP execution, and share-safe reports.',
    'security',
    'https://deeptest.live',
    NULL,
    'local_mcp',
    'installable',
    'first-party/deeptest',
    'setup_required',
    ARRAY['security_review', 'share_safe_report', 'local_mcp']::TEXT[],
    'Install or connect a DeepTest MCP runner before agents can request reviews.',
    20,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    '8f3a5a00-0e64-4d10-a517-0d0b69c1d103',
    'buildme',
    'buildme.live',
    'Project definition, scheduling, and BuildMe project-board handoff.',
    'project_management',
    'https://buildme.live',
    NULL,
    'uoa_sso',
    'link_only',
    'first-party/buildme',
    'unknown',
    ARRAY['launch', 'uoa_account_link', 'project_board_source_pending']::TEXT[],
    'Link through UOA now; native board pairing waits for the BuildMe board API contract.',
    30,
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
