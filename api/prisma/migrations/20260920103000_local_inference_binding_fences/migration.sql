-- A binding is prepared under one specific editor credential and host key/connection
-- generation. These remain nullable only to fail closed for already-created pending
-- rows from the first rollout; every new preparation supplies all applicable fields.
ALTER TABLE "agent_local_inference_bindings"
  ADD COLUMN "prepared_editor_user_id" UUID,
  ADD COLUMN "prepared_editor_token_version" INTEGER,
  ADD COLUMN "prepared_editor_uoa_subject" TEXT,
  ADD COLUMN "prepared_editor_uoa_token_version" INTEGER,
  ADD COLUMN "host_authorization_revision" INTEGER,
  ADD COLUMN "host_connection_epoch" INTEGER;
