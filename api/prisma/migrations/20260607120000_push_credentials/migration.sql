-- Platform super-admin flag + push-credential metadata storage.
--
-- `users.super_admin` introduces a platform-level role ABOVE the per-org
-- `owner`: it gates platform-global resources (the push credentials below).
-- `push_credentials` holds ONLY non-secret metadata; the secret bytes (.p8 /
-- FCM service-account JSON) live encrypted in `mcp_oauth_secret` via the
-- SecretStore, referenced by `secret_ref`.

ALTER TABLE "users" ADD COLUMN "super_admin" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "PushProvider" AS ENUM ('apns', 'fcm');
CREATE TYPE "PushApnsEnvironment" AS ENUM ('sandbox', 'production');

CREATE TABLE "push_credentials" (
    "id" UUID NOT NULL,
    "provider" "PushProvider" NOT NULL,
    "secret_ref" TEXT NOT NULL,
    "apns_key_id" TEXT,
    "apns_team_id" TEXT,
    "apns_topic" TEXT,
    "apns_environment" "PushApnsEnvironment",
    "fcm_project_id" TEXT,
    "fcm_client_email" TEXT,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "push_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_credentials_provider_key" ON "push_credentials"("provider");
