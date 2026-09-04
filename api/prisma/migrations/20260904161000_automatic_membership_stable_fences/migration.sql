ALTER TABLE "automatic_membership_rules"
  ADD COLUMN "uoa_fence_token" text NOT NULL DEFAULT gen_random_uuid()::text;
