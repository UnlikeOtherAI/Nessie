-- Narrow product-specific early access for conversational agent setup. This is
-- Nessie configuration, not a UOA identity or organization-hierarchy field.
-- Existing organizations must start disabled until an active owner opts in.
ALTER TABLE "organizations"
  ADD COLUMN "conversational_setup_enabled" BOOLEAN NOT NULL DEFAULT false;
