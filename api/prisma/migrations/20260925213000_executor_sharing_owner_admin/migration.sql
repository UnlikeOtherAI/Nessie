-- Older private assignments could downgrade the pairing owner. Under direct
-- sharing ownership always retains administration, including those old rows.
WITH restored AS (
  UPDATE executor_private_assignments a
  SET role = 'admin', updated_at = now()
  FROM executors e
  WHERE a.executor_id = e.id AND a.user_id = e.pairing_owner_user_id
    AND a.principal_kind = 'user' AND a.role <> 'admin'
  RETURNING a.executor_id
)
UPDATE executors e
SET authorization_revision = authorization_revision + 1,
    active_connection_epoch = active_connection_epoch + 1
WHERE e.id IN (SELECT executor_id FROM restored);
