-- Key UOA principals by the stable UOA subject, not email (UOA SSO gap
-- analysis 2026-08-14, Phase 2). Adds `users.uoa_sub` and backfills it from
-- the linked Nessie product account links so existing UOA principals resolve
-- by subject on their next login instead of taking the email-adoption path.

ALTER TABLE "users" ADD COLUMN "uoa_sub" TEXT;

CREATE UNIQUE INDEX "users_uoa_sub_key" ON "users"("uoa_sub");

-- Backfill from `product_account_links` rows for the `nessie` product that are
-- `linked` and carry a subject. Two ambiguity guards, both of which leave
-- `uoa_sub` NULL rather than guessing (a NULL is claimed by the one-time
-- adoption at the user's next UOA login, or surfaces as an identity conflict
-- for operator resolution):
--   1. a user whose linked rows disagree on the subject gets no backfill;
--   2. a subject that maps to more than one user backfills neither user.
WITH candidate AS (
  SELECT "user_id", MIN("uoa_sub") AS "uoa_sub"
  FROM "product_account_links"
  WHERE "product_slug" = 'nessie'
    AND "status" = 'linked'
    AND "uoa_sub" IS NOT NULL
  GROUP BY "user_id"
  HAVING COUNT(DISTINCT "uoa_sub") = 1
),
unambiguous AS (
  SELECT "uoa_sub"
  FROM candidate
  GROUP BY "uoa_sub"
  HAVING COUNT(*) = 1
)
UPDATE "users" AS u
SET "uoa_sub" = c."uoa_sub"
FROM candidate AS c
JOIN unambiguous AS ua ON ua."uoa_sub" = c."uoa_sub"
WHERE u."id" = c."user_id";
