-- A secret may now pin its own name for every narrower scope, exactly as a
-- locked `scoped_settings` row does: resolution walks organisation → team →
-- project → personal and stops at the first locked level. Existing secrets
-- lock nothing, so the default is the pre-migration behaviour.
ALTER TABLE "secrets" ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false;
