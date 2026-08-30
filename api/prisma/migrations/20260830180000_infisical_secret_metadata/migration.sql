-- Nessie stores only secret metadata and the opaque Infisical location. Values,
-- ciphertext, and key material deliberately have no column in this database.
CREATE TYPE "SecretScopeType" AS ENUM ('personal', 'team', 'project', 'workspace');
CREATE TYPE "SecretStatus" AS ENUM ('active', 'revoked', 'expired');
CREATE TYPE "SecretPermission" AS ENUM ('use', 'reveal', 'manage', 'delegate');
CREATE TYPE "SecretPrincipalType" AS ENUM ('user', 'agent', 'team', 'project', 'workspace');

CREATE TABLE "secrets" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "provider" TEXT,
    "scope_type" "SecretScopeType" NOT NULL,
    "scope_id" UUID NOT NULL,
    "vault_reference" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "rotated_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "status" "SecretStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "secrets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "secret_grants" (
    "id" UUID NOT NULL,
    "secret_id" UUID NOT NULL,
    "principal_type" "SecretPrincipalType" NOT NULL,
    "principal_id" UUID NOT NULL,
    "permissions" "SecretPermission"[] NOT NULL DEFAULT ARRAY[]::"SecretPermission"[],
    "expires_at" TIMESTAMP(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "secret_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "secrets_reference_key" ON "secrets"("reference");
CREATE UNIQUE INDEX "secrets_vault_reference_key" ON "secrets"("vault_reference");
CREATE UNIQUE INDEX "secrets_organization_id_scope_type_scope_id_name_key" ON "secrets"("organization_id", "scope_type", "scope_id", "name");
CREATE INDEX "secrets_organization_id_scope_type_scope_id_idx" ON "secrets"("organization_id", "scope_type", "scope_id");
CREATE INDEX "secrets_organization_id_status_idx" ON "secrets"("organization_id", "status");
CREATE UNIQUE INDEX "secret_grants_secret_id_principal_type_principal_id_key" ON "secret_grants"("secret_id", "principal_type", "principal_id");
CREATE INDEX "secret_grants_principal_type_principal_id_idx" ON "secret_grants"("principal_type", "principal_id");

ALTER TABLE "secrets"
  ADD CONSTRAINT "secrets_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "secret_grants"
  ADD CONSTRAINT "secret_grants_secret_id_fkey"
  FOREIGN KEY ("secret_id") REFERENCES "secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
