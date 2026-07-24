-- Fixed-window counters for the auth-sensitive request rate limiter
-- (api/src/services/rate-limit.ts). One row per (bucket, key, window start);
-- atomic upsert-increment keeps multi-replica counting safe. The limiter
-- deletes rows whose window has passed (probabilistic cleanup per hit), so
-- the table stays bounded by active keys per window. `key_hash` is a SHA-256
-- of the caller identity (IP or user id) — raw IPs are never persisted.

CREATE TABLE "rate_limit_buckets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bucket" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rate_limit_buckets_bucket_key_hash_window_start_key"
    ON "rate_limit_buckets"("bucket", "key_hash", "window_start");

CREATE INDEX "rate_limit_buckets_window_start_idx"
    ON "rate_limit_buckets"("window_start");
