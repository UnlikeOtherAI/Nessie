CREATE TABLE "executor_team_access" (
  "executor_id" UUID PRIMARY KEY REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "team_id" UUID NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "everyone" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "executor_project_access" (
  "executor_id" UUID NOT NULL REFERENCES "executors"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY ("executor_id", "project_id")
);

-- Resolve the pairing's local or UOA team reference without guessing from a session.
INSERT INTO "executor_team_access" ("executor_id", "team_id", "everyone")
SELECT e.id, t.id, e.scope_kind = 'organization'
FROM executors e JOIN teams t ON (e.pairing_team_id = t.id::text OR e.pairing_team_id = t.external_team_id)
JOIN projects p ON p.id = t.project_id AND p.organization_id = e.organization_id
WHERE NOT t.system_managed;

INSERT INTO "executor_team_access" ("executor_id", "team_id", "everyone")
SELECT e.id, p.team_id, false FROM executors e JOIN projects p ON p.id = e.project_id
WHERE e.scope_kind = 'project' AND p.team_id IS NOT NULL
ON CONFLICT (executor_id) DO NOTHING;

INSERT INTO "executor_project_access" ("executor_id", "project_id")
SELECT e.id, e.project_id FROM executors e JOIN executor_team_access a ON a.executor_id = e.id
JOIN projects p ON p.id = e.project_id AND p.team_id = a.team_id
WHERE e.scope_kind = 'project';

-- Unresolved old organisation scope becomes owner-only rather than all-organisation access.
UPDATE executors SET scope_kind = 'private', project_id = NULL,
  authorization_revision = authorization_revision + 1, active_connection_epoch = active_connection_epoch + 1
WHERE scope_kind <> 'private';

-- Every machine retains its pairing owner. Sharing never transfers ownership.
INSERT INTO executor_private_assignments (id, executor_id, principal_kind, user_id, role, created_at, updated_at)
SELECT gen_random_uuid(), id, 'user', pairing_owner_user_id, 'admin', now(), now() FROM executors
ON CONFLICT (executor_id, user_id) DO NOTHING;
INSERT INTO executor_private_assignments (id, executor_id, principal_kind, agent_id, role, created_at, updated_at)
SELECT gen_random_uuid(), executor_id, 'agent', agent_id, 'use', now(), now()
FROM executor_agent_operation_grants WHERE state = 'allowed' GROUP BY executor_id, agent_id
ON CONFLICT (executor_id, agent_id) DO NOTHING;

-- A signed capability report is machine configuration, not an approval request.
UPDATE executors e SET status = 'paused'
WHERE e.status IN ('online', 'offline', 'error') AND (
  SELECT r.review_status FROM executor_capability_revisions r
  WHERE r.executor_id = e.id ORDER BY r.revision DESC LIMIT 1
) = 'disabled';
UPDATE executor_capability_revisions SET review_status = 'active'
WHERE review_status IN ('pending_review', 'disabled');
ALTER TABLE executor_capability_revisions ALTER COLUMN review_status SET DEFAULT 'active';
