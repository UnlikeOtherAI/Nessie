-- One local-app operation per machine in a run; isolated workspaces remain
-- single-machine under the binder's run lock.
DROP INDEX "executor_bindings_run_id_operation_key_key";
CREATE UNIQUE INDEX "executor_bindings_run_id_executor_id_operation_key_key"
ON "executor_bindings" ("run_id", "executor_id", "operation_key");
