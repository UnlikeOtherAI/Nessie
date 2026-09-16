-- Provider error strings are untrusted remote input: a mail server chooses the
-- text, and it was being stored verbatim and rendered on the connector card.
-- Retain only the stable, actionable credential-rejection diagnosis; drop the
-- rest.
UPDATE "mailbox_connections"
SET "status_reason" = 'The email address or password was not accepted.'
WHERE "status" = 'needs_reauthorization';

UPDATE "mailbox_connections"
SET "status_reason" = NULL
WHERE "status" <> 'needs_reauthorization'
  AND "status_reason" IS NOT NULL;
