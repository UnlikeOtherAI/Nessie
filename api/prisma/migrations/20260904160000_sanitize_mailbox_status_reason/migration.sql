-- Provider error strings are untrusted remote input. Retain only the stable,
-- actionable credential-rejection diagnosis on legacy mailbox rows.
UPDATE "mailbox_connections"
SET "status_reason" = 'The email address or password was not accepted.'
WHERE "status" = 'needs_reauthorization';

UPDATE "mailbox_connections"
SET "status_reason" = NULL
WHERE "status" <> 'needs_reauthorization'
  AND "status_reason" IS NOT NULL;
