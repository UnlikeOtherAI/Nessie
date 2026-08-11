-- Device tokens belong to one user within one organization. A person who is a
-- member of multiple organizations can therefore register the same physical
-- device in each one without cross-tenant delivery.

DROP INDEX "device_tokens_user_id_token_key";

CREATE UNIQUE INDEX "device_tokens_organization_id_user_id_token_key"
  ON "device_tokens"("organization_id", "user_id", "token");
