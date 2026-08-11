-- A token's APNs host is a property of the signed iOS build, not a global
-- deployment setting. Keeping it with the token allows sandbox development
-- builds and production/TestFlight builds to receive from one server.

ALTER TABLE "device_tokens"
  ADD COLUMN "apns_environment" "PushApnsEnvironment";
