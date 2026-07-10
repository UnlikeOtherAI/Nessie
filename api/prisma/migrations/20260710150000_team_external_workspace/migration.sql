-- Slack-style workspace login: bind a Nessie team to a UOA workspace so each
-- selected workspace (UOA `active.teamId`) maps to its own Nessie team inside the
-- shared organization. Additive — existing teams keep NULL (not workspace-bound).
-- See docs/plans/2026-07-10-slack-workspace-login-nessie.md.

ALTER TABLE "teams"
  ADD COLUMN "external_workspace_id" TEXT,
  ADD COLUMN "external_org_id" TEXT;

-- One Nessie team per UOA workspace. Partial-unique via a standard unique index
-- (NULLs are not considered equal in Postgres, so unbound teams don't collide).
CREATE UNIQUE INDEX "teams_external_workspace_id_key"
  ON "teams" ("external_workspace_id");
