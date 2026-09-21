-- Labels belong to a board; removing a ticket file marks it instead of deleting it
-- (docs/plans/2026-09-21-ticket-comments-attachments-labels/board-labels-and-attachment-removal.md §8.3, §9.2).
--
-- A task's home board is `coalesce(tasks.board_id, <the project's is_default board>)`.
-- Every project-scoped label is re-homed onto each board that needs it: the
-- distinct home boards of the tasks linked to it, plus the project's default
-- board so an unused label survives somewhere. The existing row goes to the
-- default board (or, when the project has none, its first home board by id);
-- every further board gets a copy carrying the same name, colour, source and
-- external id, and each link is repointed to the copy on its task's own home
-- board. A label with no board to live on (a project without boards) is
-- deleted, and so is a link whose task has no home board in the label's
-- project — nothing could show either.
--
-- `task_labels.board_id` becomes NOT NULL, so a pre-swap replica creating a
-- label without it fails: listed in deploy-incompatible-migrations.json.
-- A no-op apart from the DDL on a database with no labels.

-- 1. The composite FK target, and the new column (nullable until re-homed).

CREATE UNIQUE INDEX "boards_id_project_id_key" ON "boards"("id", "project_id");

ALTER TABLE "task_labels" ADD COLUMN "board_id" UUID;

-- The project-wide keys go first: the copies below repeat a label's
-- normalised name and (source_id, external_id) within its project.
DROP INDEX "task_labels_project_id_normalized_name_key";
DROP INDEX "task_labels_source_id_external_id_key";
DROP INDEX "task_labels_project_id_name_idx";

-- 2. Re-home. One statement, so the copies' ids are generated once
--    (`targets` is MATERIALIZED) and every writer below reads the same ones;
--    the link FK is checked at the end of the statement, after the copies
--    exist.

WITH defaults AS (
  SELECT b."project_id", b."id" AS "board_id"
    FROM "boards" b
   WHERE b."is_default"
),
link_homes AS (
  SELECT DISTINCT k."label_id", hb."id" AS "board_id"
    FROM "task_label_links" k
    JOIN "task_labels" l ON l."id" = k."label_id"
    JOIN "tasks" t ON t."id" = k."task_id"
    LEFT JOIN defaults d ON d."project_id" = t."project_id"
    JOIN "boards" hb
      ON hb."id" = coalesce(t."board_id", d."board_id")
     AND hb."project_id" = l."project_id"
),
candidate AS (
  SELECT "label_id", "board_id" FROM link_homes
  UNION
  SELECT l."id", d."board_id"
    FROM "task_labels" l
    JOIN defaults d ON d."project_id" = l."project_id"
),
targets AS MATERIALIZED (
  SELECT c."label_id",
         c."board_id",
         row_number() OVER (
           PARTITION BY c."label_id"
           ORDER BY (d."board_id" IS NOT NULL) DESC, c."board_id"
         ) AS "rn",
         gen_random_uuid() AS "copy_id"
    FROM candidate c
    JOIN "task_labels" l ON l."id" = c."label_id"
    LEFT JOIN defaults d ON d."project_id" = l."project_id" AND d."board_id" = c."board_id"
),
copies AS (
  INSERT INTO "task_labels" (
    "id", "organization_id", "project_id", "board_id", "name", "normalized_name",
    "color", "source_id", "external_id", "created_by_user_id", "created_at", "updated_at"
  )
  SELECT tg."copy_id", l."organization_id", l."project_id", tg."board_id", l."name", l."normalized_name",
         l."color", l."source_id", l."external_id", l."created_by_user_id", l."created_at", l."updated_at"
    FROM targets tg
    JOIN "task_labels" l ON l."id" = tg."label_id"
   WHERE tg."rn" > 1
  RETURNING "id"
),
originals AS (
  UPDATE "task_labels" l
     SET "board_id" = tg."board_id"
    FROM targets tg
   WHERE tg."label_id" = l."id" AND tg."rn" = 1
  RETURNING l."id"
),
repointed AS (
  UPDATE "task_label_links" k
     SET "label_id" = tg."copy_id"
    FROM "tasks" t, targets tg
   WHERE t."id" = k."task_id"
     AND tg."label_id" = k."label_id"
     AND tg."rn" > 1
     AND tg."board_id" = coalesce(
           t."board_id",
           (SELECT d."board_id" FROM defaults d WHERE d."project_id" = t."project_id")
         )
  RETURNING k."task_id"
)
SELECT (SELECT count(*) FROM copies)    AS "copies",
       (SELECT count(*) FROM originals) AS "originals",
       (SELECT count(*) FROM repointed) AS "repointed";

-- A label nothing could show, and a link whose task's home board is not its
-- label's board (the task has no home board in that project).
DELETE FROM "task_labels" WHERE "board_id" IS NULL;

DELETE FROM "task_label_links" k
 USING "task_labels" l, "tasks" t
 WHERE l."id" = k."label_id"
   AND t."id" = k."task_id"
   AND l."board_id" IS DISTINCT FROM coalesce(
         t."board_id",
         (SELECT b."id" FROM "boards" b WHERE b."project_id" = t."project_id" AND b."is_default")
       );

-- 3. Board-scoped keys and the composite FK.

ALTER TABLE "task_labels" ALTER COLUMN "board_id" SET NOT NULL;

CREATE UNIQUE INDEX "task_labels_board_id_normalized_name_key"
    ON "task_labels"("board_id", "normalized_name");
CREATE UNIQUE INDEX "task_labels_board_id_source_id_external_id_key"
    ON "task_labels"("board_id", "source_id", "external_id");
CREATE INDEX "task_labels_board_id_name_idx" ON "task_labels"("board_id", "name");
CREATE INDEX "task_labels_project_id_idx" ON "task_labels"("project_id");

ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_board_id_project_id_fkey"
    FOREIGN KEY ("board_id", "project_id") REFERENCES "boards"("id", "project_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Soft removal of a ticket file. Bare columns like `uploader_id` — no
--    relation, the row outlives the people. No index: the list reads by
--    `task_id` and the card count filters `removed_at IS NULL` within it.

ALTER TABLE "attachments"
    ADD COLUMN "removed_at" TIMESTAMP(3),
    ADD COLUMN "removed_by_user_id" UUID,
    ADD COLUMN "removed_by_agent_id" UUID,
    ADD COLUMN "removed_reason" TEXT;
