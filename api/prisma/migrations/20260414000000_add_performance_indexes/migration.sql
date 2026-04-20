-- CreateIndex
CREATE INDEX IF NOT EXISTS "channels_organization_id_type_idx" ON "channels"("organization_id", "type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "channel_members_user_id_idx" ON "channel_members"("user_id");

-- CreateIndex (compound, replaces standalone channelId index)
CREATE INDEX IF NOT EXISTS "idx_threads_channel_created" ON "threads"("channel_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "agent_bindings_channel_id_idx" ON "agent_bindings"("channel_id");
