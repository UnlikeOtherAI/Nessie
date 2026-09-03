-- The credential the native layer holds during a call.
--
-- The Expo shell's standing rule is that the native app never sees an
-- authenticated Nessie session — auth lives in the WebView. A CallKit call has
-- to keep working with the screen locked and the WebView suspended, so the
-- native side needs a credential of its own. This is that amendment, made
-- deliberately and narrowly: server state, not a bare stateless JWT, so every
-- request can recheck revocation the way an ordinary session does.
--
-- The token itself is never stored. Only its SHA-256 digest is, so a database
-- read cannot be replayed as the credential.
--
-- `session_id` is the `sid` of the web session that minted it: theft of this
-- token dies with the sign-in it derives from, rather than outliving it.

CREATE TABLE "voice_device_credentials" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    -- The tenant scope the WebView held when it provisioned this device. Cost
    -- attribution is scoped by project/team, and a credential minted in one
    -- workspace must not silently bill another.
    "project_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "token_version" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_device_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "voice_device_credentials_token_hash_key" ON "voice_device_credentials"("token_hash");
-- Every request looks the credential up by digest; the partial shape keeps
-- revoked rows out of the hot path.
CREATE INDEX "voice_device_credentials_installation_id_idx" ON "voice_device_credentials"("installation_id");
-- Revoking a sign-out, or a device, has to find every credential it minted.
CREATE INDEX "voice_device_credentials_user_id_session_id_idx" ON "voice_device_credentials"("user_id", "session_id");

ALTER TABLE "voice_device_credentials" ADD CONSTRAINT "voice_device_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "voice_device_credentials" ADD CONSTRAINT "voice_device_credentials_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "voice_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
