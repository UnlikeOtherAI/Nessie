-- Ticket labels, comments and attachments
-- (docs/plans/2026-09-21-ticket-comments-attachments-labels/data-model.md §1.3).
--
-- Additive only: four new tables, two nullable columns on `attachments`, and a
-- one-time conversion of the "Labels" multi_select field board sources used to
-- create into first-class labels. Nothing here drops a column an older client
-- selects, so it is compatible with the previous release while it still serves.

-- 1. Enums and tables ─────────────────────────────────────────────────────────

CREATE TYPE "TaskExternalAssetKind" AS ENUM ('file', 'inline_image', 'link');
CREATE TYPE "TaskExternalAssetStatus" AS ENUM ('pending', 'stored', 'failed', 'link');

CREATE TABLE "task_labels" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6b7280',
    "source_id" UUID,
    "external_id" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_labels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_labels_project_id_normalized_name_key"
    ON "task_labels"("project_id", "normalized_name");
CREATE UNIQUE INDEX "task_labels_source_id_external_id_key"
    ON "task_labels"("source_id", "external_id");
CREATE INDEX "task_labels_project_id_name_idx" ON "task_labels"("project_id", "name");

ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "board_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "task_label_links" (
    "task_id" UUID NOT NULL,
    "label_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_label_links_pkey" PRIMARY KEY ("task_id", "label_id")
);

CREATE INDEX "task_label_links_label_id_idx" ON "task_label_links"("label_id");

ALTER TABLE "task_label_links" ADD CONSTRAINT "task_label_links_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_label_links" ADD CONSTRAINT "task_label_links_label_id_fkey"
    FOREIGN KEY ("label_id") REFERENCES "task_labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "task_comments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "author_user_id" UUID,
    "author_agent_id" UUID,
    "external_author_external_id" TEXT,
    "external_author_display" TEXT,
    "body" TEXT NOT NULL,
    "source_id" UUID,
    "external_id" TEXT,
    "external_url" TEXT,
    "parent_external_id" TEXT,
    "external_updated_at" TIMESTAMP(3),
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_comments_source_id_external_id_key"
    ON "task_comments"("source_id", "external_id");
CREATE INDEX "task_comments_task_id_created_at_idx" ON "task_comments"("task_id", "created_at");

ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_agent_id_fkey"
    FOREIGN KEY ("author_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "board_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "task_external_assets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "task_comment_id" UUID,
    "source_id" UUID NOT NULL,
    "external_url" TEXT NOT NULL,
    "external_id" TEXT,
    "kind" "TaskExternalAssetKind" NOT NULL,
    "status" "TaskExternalAssetStatus" NOT NULL DEFAULT 'pending',
    "title" TEXT,
    "attachment_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_external_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_external_assets_source_id_external_url_key"
    ON "task_external_assets"("source_id", "external_url");
CREATE INDEX "task_external_assets_task_id_idx" ON "task_external_assets"("task_id");
CREATE INDEX "task_external_assets_status_updated_at_idx"
    ON "task_external_assets"("status", "updated_at");

ALTER TABLE "task_external_assets" ADD CONSTRAINT "task_external_assets_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_external_assets" ADD CONSTRAINT "task_external_assets_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_external_assets" ADD CONSTRAINT "task_external_assets_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "board_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Ticket pointers on attachments. App-enforced, no FK — the `message_id`
--    precedent: the file service owns the row's lifecycle, not the ticket.

ALTER TABLE "attachments" ADD COLUMN "task_id" UUID, ADD COLUMN "task_comment_id" UUID;
CREATE INDEX "attachments_task_id_idx" ON "attachments"("task_id");
CREATE INDEX "attachments_task_comment_id_idx" ON "attachments"("task_comment_id");

-- 3. A comment has at most one Nessie author. Both null is an imported comment
--    whose provider author no identity link resolves.

ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_one_author"
    CHECK (NOT ("author_user_id" IS NOT NULL AND "author_agent_id" IS NOT NULL));

-- 4. Convert the "Labels" multi_select field board sources created into
--    first-class labels.
--
-- For every board source mapping `labels` to a `field:<definitionId>` that is
-- a multi_select of the source's project: each option becomes a source-owned
-- label (a same-name label is adopted), each task's chosen options become label
-- links, the mapping entry is rewritten to `native:labels` in place (order
-- kept, its option `valueMap` dropped — it mapped to options that no longer
-- exist), the definition's values and any board filter on it are cleared, and
-- the definition is deleted.
--
-- `external_id` is the provider's label id: the `valueMap` key that maps to the
-- option when the mapping has one, otherwise the option id itself (attach
-- stores the adapter's option ids verbatim).
--
-- A stored value that matches no option (GitHub and Trello declare the field
-- without options, so their values are bare provider ids with no name) cannot
-- become a named label here; the next sync re-applies those tickets' labels
-- from the provider with their names. A mapping whose target no longer exists
-- (a second source that shared an already-converted definition) is still
-- rewritten. A target that is not a multi_select is left alone.
--
-- A no-op on a database with no board sources.

DO $$
DECLARE
  src RECORD;
  mapping JSONB;
  def_id UUID;
  def_options JSONB;
  def_found BOOLEAN;
  opt JSONB;
  opt_name TEXT;
  ext_id TEXT;
  label_id UUID;
  option_labels JSONB;
BEGIN
  FOR src IN
    SELECT s.id, s.project_id, s.organization_id, s.field_mappings
      FROM "board_sources" s
     WHERE jsonb_typeof(s.field_mappings) = 'array'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(s.field_mappings) e
          WHERE e->>'externalKey' = 'labels' AND e->>'target' LIKE 'field:%'
       )
  LOOP
    FOR mapping IN
      SELECT e
        FROM jsonb_array_elements(src.field_mappings) e
       WHERE e->>'externalKey' = 'labels' AND e->>'target' LIKE 'field:%'
    LOOP
      def_id := NULL;
      IF substring(mapping->>'target' FROM 7) ~ '^[0-9a-fA-F-]{36}$' THEN
        def_id := substring(mapping->>'target' FROM 7)::uuid;
      END IF;

      SELECT d.options, TRUE INTO def_options, def_found
        FROM "task_field_definitions" d
       WHERE d.id = def_id AND d.project_id = src.project_id;
      IF NOT FOUND THEN
        def_found := FALSE;
        def_options := NULL;
      ELSIF NOT EXISTS (
        SELECT 1 FROM "task_field_definitions" d
         WHERE d.id = def_id AND d.type = 'multi_select'
      ) THEN
        CONTINUE;
      END IF;

      IF def_found THEN
        option_labels := '{}'::jsonb;
        FOR opt IN
          SELECT o
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(def_options) = 'array' THEN def_options ELSE '[]'::jsonb END
            ) o
        LOOP
          opt_name := left(btrim(coalesce(opt->>'label', '')), 60);
          CONTINUE WHEN opt_name = '' OR coalesce(opt->>'id', '') = '';

          ext_id := NULL;
          IF jsonb_typeof(mapping->'valueMap') = 'object' THEN
            SELECT v.key INTO ext_id
              FROM jsonb_each_text(mapping->'valueMap') v
             WHERE v.value = opt->>'id'
             ORDER BY v.key
             LIMIT 1;
          END IF;
          ext_id := coalesce(ext_id, opt->>'id');

          INSERT INTO "task_labels" (
            "id", "organization_id", "project_id", "name", "normalized_name",
            "color", "source_id", "external_id", "created_at", "updated_at"
          )
          VALUES (
            gen_random_uuid(), src.organization_id, src.project_id, opt_name, lower(opt_name),
            '#6b7280', src.id, ext_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT ("project_id", "normalized_name") DO UPDATE
             SET "source_id" = EXCLUDED."source_id",
                 "external_id" = EXCLUDED."external_id",
                 "updated_at" = CURRENT_TIMESTAMP
          RETURNING "id" INTO label_id;

          option_labels := option_labels || jsonb_build_object(opt->>'id', label_id::text);
        END LOOP;

        INSERT INTO "task_label_links" ("task_id", "label_id", "created_at")
        SELECT DISTINCT t.id, (option_labels->>v.value)::uuid, CURRENT_TIMESTAMP
          FROM "tasks" t
         CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(t.field_values->(def_id::text)) = 'array'
                THEN t.field_values->(def_id::text)
                ELSE '[]'::jsonb END
         ) v
         WHERE t.project_id = src.project_id
           AND option_labels ? v.value
        ON CONFLICT DO NOTHING;

        UPDATE "tasks"
           SET "field_values" = "field_values" - def_id::text
         WHERE "organization_id" = src.organization_id
           AND "field_values" ? def_id::text;

        UPDATE "boards"
           SET "filter" = "filter" - 'field'
         WHERE "project_id" = src.project_id
           AND "filter"->'field'->>'fieldId' = def_id::text;

        DELETE FROM "task_field_definitions" WHERE "id" = def_id;
      END IF;
    END LOOP;

    UPDATE "board_sources"
       SET "field_mappings" = (
         SELECT coalesce(jsonb_agg(
                  CASE
                    WHEN e->>'externalKey' = 'labels'
                     AND e->>'target' LIKE 'field:%'
                     AND NOT EXISTS (
                       SELECT 1 FROM "task_field_definitions" d
                        WHERE d.project_id = src.project_id
                          AND d.id::text = substring(e->>'target' FROM 7)
                     )
                    THEN (e - 'valueMap') || jsonb_build_object('target', 'native:labels')
                    ELSE e
                  END
                  ORDER BY ord
                ), '[]'::jsonb)
           FROM jsonb_array_elements("field_mappings") WITH ORDINALITY AS m(e, ord)
       )
     WHERE "id" = src.id;
  END LOOP;
END
$$;
