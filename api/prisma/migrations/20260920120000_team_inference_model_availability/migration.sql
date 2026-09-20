-- Team-level model availability is product policy, not a second copy of
-- Ledger's catalogue or of UOA's team data. An absent row inherits the
-- organisation decision; enabled rows only record a team's reversible choice.
CREATE TABLE "team_inference_model_availability" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_by_actor_id" TEXT NOT NULL,
    "updated_by_actor_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_inference_model_availability_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_inference_model_availability_team_id_provider_model_key"
  ON "team_inference_model_availability"("team_id", "provider", "model");
CREATE INDEX "team_inference_model_availability_team_id_enabled_idx"
  ON "team_inference_model_availability"("team_id", "enabled");

ALTER TABLE "team_inference_model_availability"
  ADD CONSTRAINT "team_inference_model_availability_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
