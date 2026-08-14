CREATE INDEX "refresh_tokens_user_id_session_id_idx"
ON "refresh_tokens"("user_id", "session_id");
