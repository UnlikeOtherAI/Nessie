-- One server-side sequence orders every physical-device ownership handoff.
-- It is global, rather than per user, so a late former-account request cannot
-- reclaim a token after a newer account registers the same installation.

CREATE TABLE "push_registration_generations" (
  "id" INTEGER NOT NULL,
  "value" BIGINT NOT NULL,

  CONSTRAINT "push_registration_generations_pkey" PRIMARY KEY ("id")
);

INSERT INTO "push_registration_generations" ("id", "value") VALUES (1, 0);

ALTER TABLE "device_tokens"
  ADD COLUMN "registration_version" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "device_tokens"
  ADD COLUMN "inactive_at" TIMESTAMP(3);
