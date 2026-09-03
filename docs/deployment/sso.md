# SSO (UnlikeOtherAuthenticator)

Chapter of [deployment.md](../deployment.md). How Nessie signs people in through UOA's config-JWT flow.

## SSO (UnlikeOtherAuthenticator)

The admin login page shows a single **"Sign in with SSO"** button that takes the
user to **`https://authentication.unlikeotherai.com`** (UOA). UOA is **not**
standard OIDC — Nessie integrates via UOA's config-JWT flow
(`api/src/services/uoa-auth.ts`), implemented per the integration guide at
`https://authentication.unlikeotherai.com/llm` and `/api`.

**How it works**

- The API serves a signed RS256 **config JWT** at
  `GET /api/auth/sso/config` (the `config_url`) and the matching **JWKS** at
  `GET /.well-known/jwks.json`, both on `api.nessie.works`. The
  config allowlists both the hosted web callback and the native desktop
  callback: `nessie://auth/callback`. The config endpoint accepts
  `?theme=<theme-id>` so UOA can render with the user's selected Nessie palette.
- On the web, clicking the button sends the browser to
  `GET <uoa>/auth?config_url=…&redirect_url=https://app.nessie.works/login&code_challenge=…&code_challenge_method=S256`.
  The admin includes the resolved selected theme when it asks the API for this
  authorize URL; the API adds that theme to the UOA `config_url`.
- In the Tauri desktop app, clicking the button keeps the admin webview on the
  login page, opens the UOA authorize URL in the user's system browser, and uses
  `redirect_url=nessie://auth/callback`.
- UOA renders its login UI (email/password, Google, …). On web success it redirects
  to `https://app.nessie.works/login?code=…` (byte-exact allowlist; the
  admin immediately replaces that landing with its dedicated
  `/login/completing?code=…` screen while retaining `/login` as the redirect URI
  used for the code exchange). On desktop success macOS opens
  `nessie://auth/callback?code=…`; Tauri's deep-link plugin delivers that URL to
  the admin login page, which exchanges the code with the same redirect URL.
- The API exchanges the code server-to-server at `POST <uoa>/auth/token`
  authenticated with `Bearer <client_hash>` where
  `client_hash = SHA256(domain + client_secret)`. For themed login attempts,
  the callback exchange reuses the same themed `config_url` that was sent to
  UOA during authorize. The API then reads `email`/`sub` from the returned
  access-token claims. If UOA omits a usable `name` claim, or sends the email
  address as the name, Nessie stores a humanized email local part instead.
  Session hydration also repairs legacy email-shaped display names so chat
  messages do not render raw email addresses as sender names.
- The **first** SSO user on a fresh instance bootstraps the default
  team and becomes its owner — there is no separate owner-account step.
  Bootstrap mode is automatically suppressed whenever an SSO provider is
  configured.

**One-time onboarding (required before first login works)**

1. Generate an RSA-2048 keypair and set `UOA_CONFIG_JWT_PRIVATE_KEY_B64`
   (base64 of the PEM, single line) + `UOA_CONFIG_JWT_KID` in the host `.env`,
   plus `UOA_DOMAIN`, `UOA_CONFIG_URL`, `UOA_JWKS_URL`, `UOA_REDIRECT_URL`,
   `UOA_CONTACT_EMAIL` in `/srv/nessie/infrastructure/compose/.env`. The deploy
   already does this.
   `UOA_CONFIG_JWT_KID` must be unique per UOA domain. The `api.nessie.works`
   production integration uses `nessie-works-2026-06`; do not reuse the legacy
   `api.nessie.unlikeotherai.com` kid (`nessie-2026-06`) because UOA resolves
   `kid` globally, verifies the config with the old domain key, skips
   auto-onboarding, and then rejects `/auth/token` with 401 because no
   `api.nessie.works` client secret exists.
2. Validate the config JWT (optional sanity check):
   `curl -XPOST <uoa>/config/validate -d '{"config_url":"https://api.nessie.works/api/auth/sso/config"}'`
   — expect `schema_valid: true`, `domain_match: true`. The signature check
   stays `false` until UOA stores the JWKS at approval time.
3. Click **Sign in with SSO** once. UOA captures an integration request
   ("Integration pending review") for `api.nessie.works`.
4. A UOA **superuser approves** the integration; the contact email then receives
   a **one-time link to copy the `client_secret`**.
5. Set `UOA_CLIENT_SECRET` in the host `.env` and restart the API
   (`docker compose -f infrastructure/compose/docker-compose.prod.yml up -d --no-deps --force-recreate api`).
   SSO login is now live.

For the 2026-06-15 `nessie.works` migration, the live host env was updated to
`UOA_CONFIG_JWT_KID=nessie-works-2026-06`, UOA was prompted once via `/auth` so
it created a pending `api.nessie.works` request, a UOA superuser accepted that
request with one-time credential reveal, and the resulting `UOA_CLIENT_SECRET`
was written to `/srv/nessie/infrastructure/compose/.env` before recreating only
the `nessie-api` container.

`nessie.config.json` enables the provider (`type: "uoa"`, `enabled: true`); no
`clientId`/`issuerUrl` are needed (the config-JWT `config_url` identifies the
client, and the secret derives the bearer hash).
