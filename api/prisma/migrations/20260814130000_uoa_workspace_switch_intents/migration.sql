CREATE TABLE "uoa_workspace_switch_intents" (
  "family_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "provider_id" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "source_organization_id" TEXT NOT NULL,
  "source_team_id" TEXT NOT NULL,
  "source_token_version" INTEGER NOT NULL,
  "source_generation" INTEGER NOT NULL,
  "source_local_token_id" UUID NOT NULL,
  "source_upstream_token_hash" TEXT NOT NULL,
  "target_organization_id" TEXT NOT NULL,
  "target_team_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "uoa_workspace_switch_intents_pkey" PRIMARY KEY ("family_id")
);

CREATE INDEX "uoa_workspace_switch_intents_user_id_idx"
  ON "uoa_workspace_switch_intents"("user_id");

ALTER TABLE "uoa_workspace_switch_intents"
  ADD CONSTRAINT "uoa_workspace_switch_intents_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "uoa_workspace_switch_intents"
  ADD CONSTRAINT "uoa_workspace_switch_intents_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "uoa_session_credentials"("family_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
