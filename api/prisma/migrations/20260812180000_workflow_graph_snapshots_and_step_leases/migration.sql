-- W4: pin the executed graph. `workflow_installations.pinned_graph_json` is the
-- install-time snapshot a NEW run is created from; `workflow_runs.graph_snapshot`
-- is the frozen copy an in-flight run executes from, so a template edit cannot
-- mutate a run already executing.
--
-- W6: lease columns on workflow_step_runs. A worker claiming an actively-worked
-- step writes lease_owner_id/lease_expires_at and heartbeats; suspended steps
-- (agent_task, environment_launch) hold no lease and carry deadline_at instead.
-- The reaper sweeps either condition.

ALTER TABLE "workflow_installations"
  ADD COLUMN "pinned_graph_json" JSONB;

ALTER TABLE "workflow_runs"
  ADD COLUMN "graph_snapshot" JSONB;

ALTER TABLE "workflow_step_runs"
  ADD COLUMN "lease_owner_id" TEXT,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "deadline_at" TIMESTAMP(3);

-- Backfill where it is safe to do so: an installation with no runs in flight
-- pins the template's current graph, and every existing run snapshots the graph
-- it has actually been executing against (the template's current graph, which
-- is what loadWorkflowGraph read before this change). In-flight runs keep their
-- snapshot immutable from here on.
UPDATE "workflow_installations" AS wi
SET "pinned_graph_json" = wt."graph_json"
FROM "workflow_templates" AS wt
WHERE wt."id" = wi."workflow_template_id"
  AND wi."pinned_graph_json" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "workflow_runs" AS wr
    WHERE wr."installation_id" = wi."id"
      AND wr."status" IN ('pending', 'running')
  );

UPDATE "workflow_runs" AS wr
SET "graph_snapshot" = wt."graph_json"
FROM "workflow_installations" AS wi
JOIN "workflow_templates" AS wt ON wt."id" = wi."workflow_template_id"
WHERE wi."id" = wr."installation_id"
  AND wr."graph_snapshot" IS NULL;

CREATE INDEX "workflow_step_runs_status_lease_expires_at_idx"
  ON "workflow_step_runs" ("status", "lease_expires_at");

CREATE INDEX "workflow_step_runs_status_deadline_at_idx"
  ON "workflow_step_runs" ("status", "deadline_at");
