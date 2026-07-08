-- MCP dynamic OAuth support: refreshable token bundles, cross-process
-- authorization state, and dynamically registered OAuth clients.

-- AlterTable
ALTER TABLE "mcp_oauth_secret" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "mcp_oauth_states" (
    "token" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_states_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "mcp_oauth_clients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_ref" TEXT,
    "redirect_uris" TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_oauth_clients_organization_id_issuer_key" ON "mcp_oauth_clients"("organization_id", "issuer");

-- AddForeignKey
ALTER TABLE "mcp_oauth_clients" ADD CONSTRAINT "mcp_oauth_clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
