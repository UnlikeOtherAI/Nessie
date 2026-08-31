-- Native WebViews can share a browser engine's user agent. Keep their declared
-- shell kind beside the session so the security surface can distinguish them
-- from a browser session without trusting a display-time guess.
ALTER TABLE "refresh_tokens" ADD COLUMN "client_type" TEXT;
