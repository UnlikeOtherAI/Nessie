ALTER TABLE task_sets ADD COLUMN processor_pin JSONB,
  ADD COLUMN source_attachment_id UUID REFERENCES attachments(id) ON DELETE RESTRICT;
ALTER TABLE task_set_items ADD COLUMN retry_base INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_set_attempts ADD COLUMN input_snapshot JSONB;
CREATE TABLE task_set_item_revisions (
  id UUID PRIMARY KEY, item_id UUID NOT NULL REFERENCES task_set_items(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, snapshot JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_id, revision)
);
CREATE TABLE task_set_steps (
  id UUID PRIMARY KEY, attempt_id UUID NOT NULL REFERENCES task_set_attempts(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL, input_hash TEXT NOT NULL, result JSONB,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMP(3),
  UNIQUE(attempt_id, sequence)
);
