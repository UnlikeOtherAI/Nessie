-- A native APNs/FCM token identifies one physical installation. Retaining it
-- for multiple accounts can deliver a former user's private previews to the
-- next person who signs into a shared device. Keep the most recently seen row
-- before applying the ownership invariant.

WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "token"
      ORDER BY "last_seen_at" DESC, "created_at" DESC, "id" DESC
    ) AS row_number
  FROM "device_tokens"
)
DELETE FROM "device_tokens"
WHERE "id" IN (SELECT "id" FROM ranked WHERE row_number > 1);

DROP INDEX "device_tokens_organization_id_user_id_token_key";

CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");
