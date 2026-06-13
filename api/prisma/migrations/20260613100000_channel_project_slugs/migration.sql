ALTER TABLE "channels" ADD COLUMN "project_id" UUID;
ALTER TABLE "channels" ADD COLUMN "slug" TEXT;

UPDATE "channels" AS c
SET "project_id" = t."project_id"
FROM "teams" AS t
WHERE c."team_id" = t."id";

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
WHERE "type" = 'standard';

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
ALTER TABLE "channels"
  ADD CONSTRAINT "channels_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "channels"
  ADD CONSTRAINT "channels_standard_slug_required"
  CHECK ("type" <> 'standard' OR "slug" IS NOT NULL);

CREATE INDEX "channels_project_id_idx" ON "channels"("project_id");
CREATE UNIQUE INDEX "channels_project_slug_standard_key"
  ON "channels"("project_id", "slug")
  WHERE "type" = 'standard';
