ALTER TABLE task_set_items ADD COLUMN input_hash TEXT;
ALTER TABLE task_set_attempts ADD COLUMN pending_outcome JSONB;
