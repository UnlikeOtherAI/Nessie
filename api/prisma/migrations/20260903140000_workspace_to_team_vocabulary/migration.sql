-- Domain vocabulary: the thing a person belongs to is a "team" everywhere.
--
-- Nessie's product word used to be "workspace" while the row, the SSO and half
-- the routes already said "team" (see docs/standards/team-model.md). This
-- migration retires the second word at the storage layer. Every statement is a
-- rename: no row is read, written or moved, so it is fast and reversible.
--
-- The executor's own "workspace" — its copy-on-write filesystem sandbox — is a
-- different concept that keeps its name, so `ExecutorProfile.workspace_sandbox`
-- is deliberately untouched.

-- Team.externalWorkspaceId -> Team.externalTeamId. The column always held a UOA
-- team id; only the local spelling was ever "workspace".
ALTER TABLE "teams" RENAME COLUMN "external_workspace_id" TO "external_team_id";
ALTER INDEX "teams_external_workspace_id_key" RENAME TO "teams_external_team_id_key";

-- UoaWorkspaceSwitchIntent -> UoaTeamSwitchIntent.
ALTER TABLE "uoa_workspace_switch_intents" RENAME TO "uoa_team_switch_intents";
ALTER INDEX "uoa_workspace_switch_intents_pkey" RENAME TO "uoa_team_switch_intents_pkey";
ALTER INDEX "uoa_workspace_switch_intents_user_id_idx" RENAME TO "uoa_team_switch_intents_user_id_idx";
ALTER TABLE "uoa_team_switch_intents"
  RENAME CONSTRAINT "uoa_workspace_switch_intents_user_id_fkey" TO "uoa_team_switch_intents_user_id_fkey";
ALTER TABLE "uoa_team_switch_intents"
  RENAME CONSTRAINT "uoa_workspace_switch_intents_family_id_fkey" TO "uoa_team_switch_intents_family_id_fkey";

-- An agent visible to everyone in the team, and the alert that invites someone
-- into one, both carried the old word.
ALTER TYPE "AgentVisibility" RENAME VALUE 'workspace' TO 'team';
ALTER TYPE "UserAlertKind" RENAME VALUE 'workspace_invitation' TO 'team_invitation';

-- These two never meant the team. `SecretScopeType.workspace` and
-- `SecretPrincipalType.workspace` resolve to the organisation id
-- (api/src/routes/secrets.ts), and sat beside a real 'team' value — the sibling
-- "Team"/"Workspace" scopes docs/standards/team-model.md calls out as wrong.
-- Renaming them to 'workspace' -> 'team' would have collided with that real
-- value, so they take the name they always meant.
ALTER TYPE "SecretScopeType" RENAME VALUE 'workspace' TO 'organization';
ALTER TYPE "SecretPrincipalType" RENAME VALUE 'workspace' TO 'organization';
