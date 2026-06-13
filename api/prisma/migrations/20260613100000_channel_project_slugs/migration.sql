ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "project_id" UUID;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "slug" TEXT;

UPDATE "channels" AS c
SET "project_id" = t."project_id"
FROM "teams" AS t
WHERE c."team_id" = t."id"
  AND c."project_id" IS NULL;

UPDATE "channels"
SET "slug" = NULLIF(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim("label")), '[^a-z0-9[:space:]-]', '', 'g'),
        '[[:space:]]+',
        '-',
        'g'
      ),
      '-+',
      '-',
      'g'
    ),
    '(^-+|-+$)',
    '',
    'g'
  ),
  ''
)
WHERE "type" = 'standard'
  AND ("slug" IS NULL OR "slug" = '');

WITH duplicate_standard_channels AS (
  SELECT "id", "duplicate_rank"::text || '-' || "short_id" AS "suffix"
  FROM (
    SELECT
      "id",
      substr(replace("id"::text, '-', ''), 1, 8) AS "short_id",
      row_number() OVER (
        PARTITION BY "project_id", "slug"
        ORDER BY
          CASE WHEN "archived_at" IS NULL THEN 0 ELSE 1 END,
          "created_at",
          "id"
      ) AS "duplicate_rank"
    FROM "channels"
    WHERE "type" = 'standard'
      AND "project_id" IS NOT NULL
      AND "slug" IS NOT NULL
  ) AS ranked_standard_channels
  WHERE "duplicate_rank" > 1
)
UPDATE "channels" AS c
SET
  "label" = CASE
    WHEN right(c."label", length(' ' || d."suffix")) = ' ' || d."suffix" THEN c."label"
    ELSE c."label" || ' ' || d."suffix"
  END,
  "slug" = CASE
    WHEN right(c."slug", length('-' || d."suffix")) = '-' || d."suffix" THEN c."slug"
    ELSE c."slug" || '-' || d."suffix"
  END,
  "updated_at" = now()
FROM duplicate_standard_channels AS d
WHERE c."id" = d."id";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "channels" WHERE "project_id" IS NULL) THEN
    RAISE EXCEPTION 'Cannot add project-scoped channel slugs: at least one channel has no project through its team';
  END IF;

  IF EXISTS (SELECT 1 FROM "channels" WHERE "type" = 'standard' AND "slug" IS NULL) THEN
    RAISE EXCEPTION 'Cannot add project-scoped channel slugs: at least one standard channel label has no slug characters';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "channels"
    WHERE "type" = 'standard'
    GROUP BY "project_id", "slug"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add project-scoped channel slugs: duplicate standard channel slugs exist within a project, including archived channels';
  END IF;
END $$;

ALTER TABLE "channels" ALTER COLUMN "project_id" SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conrelid" = '"channels"'::regclass
      AND "conname" = 'channels_project_id_fkey'
  ) THEN
    ALTER TABLE "channels"
      ADD CONSTRAINT "channels_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conrelid" = '"channels"'::regclass
      AND "conname" = 'channels_standard_slug_required'
  ) THEN
    ALTER TABLE "channels"
      ADD CONSTRAINT "channels_standard_slug_required"
      CHECK ("type" <> 'standard' OR "slug" IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "channels_project_id_idx" ON "channels"("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "channels_project_slug_standard_key"
  ON "channels"("project_id", "slug")
  WHERE "type" = 'standard';
