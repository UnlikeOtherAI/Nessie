CREATE TYPE "FavoriteTargetType" AS ENUM ('agent', 'channel', 'user');

CREATE TABLE "favorites" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "target_type" "FavoriteTargetType" NOT NULL,
  "target_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "favorites_user_id_organization_id_target_type_target_id_key"
  ON "favorites"("user_id", "organization_id", "target_type", "target_id");

CREATE INDEX "favorites_organization_id_target_type_target_id_idx"
  ON "favorites"("organization_id", "target_type", "target_id");

ALTER TABLE "favorites"
  ADD CONSTRAINT "favorites_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "favorites"
  ADD CONSTRAINT "favorites_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
