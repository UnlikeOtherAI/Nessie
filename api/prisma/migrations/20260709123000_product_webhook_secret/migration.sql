-- DeepSignal integration (§6): per-organization signing secret for an integrated
-- product's inbound webhooks (`insight.surfaced`). An org admin pastes the secret
-- the product returned at webhook-registration time; it is stored encrypted at
-- rest (AES-256-GCM) and only ever read to verify an inbound HMAC signature.

CREATE TABLE "product_webhook_secrets" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "product_slug"    TEXT NOT NULL,
  "ciphertext"      TEXT NOT NULL,
  "iv"              TEXT NOT NULL,
  "auth_tag"        TEXT NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_webhook_secrets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_webhook_secrets_organization_id_product_slug_key"
  ON "product_webhook_secrets" ("organization_id", "product_slug");

ALTER TABLE "product_webhook_secrets"
  ADD CONSTRAINT "product_webhook_secrets_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
