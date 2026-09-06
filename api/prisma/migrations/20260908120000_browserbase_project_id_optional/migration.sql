-- Browserbase resolves the project from the API key, so Nessie stops asking
-- for a project id: the connect form has no field for it, the connect body no
-- longer requires it, and the client omits `projectId` from a request when the
-- connection carries none.
--
-- The column is made nullable rather than dropped. A connection made before
-- this shipped has a project id, its Browserbase sessions and its persistent
-- contexts — the ones holding people's logins — are scoped to that project,
-- and dropping it would silently move that install's agents to a different
-- project and strand every sign-in they had. So old rows keep theirs and keep
-- sending it; new rows are null and send nothing.
--
-- One exception, and it is the right one: replacing the key on an existing
-- connection through the new form clears the stored project id, because the
-- probe that accepted the new key validated it against the project the key
-- itself resolves to — not against the project the old key was pinned to.

-- AlterTable
ALTER TABLE "cloud_browser_connections" ALTER COLUMN "project_id" DROP NOT NULL;
