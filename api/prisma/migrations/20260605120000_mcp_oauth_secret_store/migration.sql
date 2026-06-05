-- Persistent, encrypted backing table for the MCP OAuth SecretStore.
CREATE TABLE "mcp_oauth_secret" (
    "ref" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mcp_oauth_secret_pkey" PRIMARY KEY ("ref")
);
