-- The native WebView retains this secret before registration; only its hash is
-- durable. It lets the physical installation recover a lost response without
-- treating a copied APNs/FCM routing token as proof of possession.
ALTER TABLE "device_tokens" ADD COLUMN "device_recovery_key_hash" TEXT;
