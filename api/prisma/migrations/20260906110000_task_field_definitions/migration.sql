-- Custom fields: project-scoped definitions, values in one JSONB column on the
-- task keyed by definition id.
--
-- Not an EAV table. The board already reads whole tasks, so JSONB adds no join;
-- the only server-side filter is a board's select-option clause, which the GIN
-- index below serves; and a definition delete is one `field_values - '<id>'`
-- UPDATE rather than a second table to keep in step.

CREATE TYPE "TaskFieldType" AS ENUM ('text', 'number', 'date', 'url', 'select', 'multi_select', 'user');

CREATE TABLE "task_field_definitions" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TaskFieldType" NOT NULL,
    "position" INTEGER NOT NULL,
    "show_on_card" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB NOT NULL DEFAULT '[]',
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_field_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_field_definitions_project_id_name_key"
    ON "task_field_definitions"("project_id", "name");
CREATE INDEX "task_field_definitions_project_id_position_idx"
    ON "task_field_definitions"("project_id", "position");

ALTER TABLE "task_field_definitions" ADD CONSTRAINT "task_field_definitions_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_field_definitions" ADD CONSTRAINT "task_field_definitions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tasks" ADD COLUMN "field_values" JSONB NOT NULL DEFAULT '{}';

-- `jsonb_path_ops` rather than the default operator class: it is smaller and
-- faster, and containment (`@>`) is the only operator the board filter uses.
CREATE INDEX "tasks_field_values_gin" ON "tasks" USING gin ("field_values" jsonb_path_ops);
