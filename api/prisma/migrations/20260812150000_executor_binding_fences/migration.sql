-- Fences are distinct from daemon connection epochs. A binding gets a new
-- monotonic token so a retry can prove it is using the same durable authority.
ALTER TABLE "executors"
  ADD COLUMN "next_binding_fence" BIGINT NOT NULL DEFAULT 0;
