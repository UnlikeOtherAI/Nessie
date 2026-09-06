-- Links a health alert to the rule it is about, so it can revalidate.
-- The alert revalidates against the rule's live health, exactly as
-- trigger_health revalidates its trigger: once an administrator re-authorizes,
-- the bell item stops surfacing without anything having to remember to delete
-- it. Without the relation there is nothing to revalidate against, because a
-- rule id in JSON metadata cannot be joined.
ALTER TABLE "user_alerts"
  ADD COLUMN "automatic_membership_rule_id" UUID;

CREATE INDEX "user_alerts_automatic_membership_rule_id_idx"
  ON "user_alerts" ("automatic_membership_rule_id");

ALTER TABLE "user_alerts"
  ADD CONSTRAINT "user_alerts_automatic_membership_rule_id_fkey"
  FOREIGN KEY ("automatic_membership_rule_id")
  REFERENCES "automatic_membership_rules"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
