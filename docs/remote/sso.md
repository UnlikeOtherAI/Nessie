# Remote — SSO Integration

Identity for the remote server is delegated to
**`authentication.unlikeotherai.com`** (UOA — "UnlikeOtherAuthenticator").
This document records the contract because UOA is **not** a drop-in OIDC
provider; the brief refers to OIDC generically, but UOA is a custom OAuth 2.0
service with a signed-config trust model.

## Key differences from plain OIDC

- **No OIDC discovery document.** There is no `/.well-known/openid-configuration`.
- **No JWKS endpoint.** Access tokens are signed with HS256 using the
  provider's `SHARED_SECRET`, which every trusted client also holds. There
  are no rotating public keys to fetch.
- **Client identity = domain + shared secret.** A client is identified by
  the SHA-256 (or HMAC, exact scheme recorded in UOA docs) of
  `domain + SHARED_SECRET`. That hash is sent as a `Bearer` token on the
  server-to-server `/auth/token` call.
- **Client config is a signed JWT.** The client serves a public URL whose
  body is a JWT (HS256, `SHARED_SECRET`) describing enabled auth methods,
  allowed redirect URLs, theme, 2FA, etc. UOA fetches and verifies this JWT
  on every auth initiation.
- **Access token is an HS256 JWT**, 15–60 min TTL, paired with a rotating
  opaque refresh token. User-context API calls to UOA use the header
  `X-UOA-Access-Token: <access_token>`.
- Revocation endpoint is `POST /auth/revoke`.

## Environment variables (server-side)

```
REMOTE_UOA_BASE_URL=https://authentication.unlikeotherai.com
REMOTE_UOA_DOMAIN=remote.helper.local         # this server's domain
REMOTE_UOA_SHARED_SECRET=<set via secret mgr> # HS256 signing key
REMOTE_UOA_AUDIENCE=auth.unlikeotherai.com    # JWT aud claim expected by UOA
REMOTE_UOA_CONFIG_URL=https://remote.helper.local/auth/uoa-config
REMOTE_UOA_REDIRECT_URL=https://remote.helper.local/auth/callback
REMOTE_UOA_OWNER_SUB=<the single user's UOA sub>
```

Secrets never live in the repo. For local dev, use `.env` (gitignored).

## Flow

### 1. Serve the signed client config

The remote server exposes a public endpoint that returns a signed JWT
describing itself as a UOA client:

```
GET /auth/uoa-config  ->  application/jwt
```

Claims:

```json
{
  "aud": "auth.unlikeotherai.com",
  "domain": "remote.helper.local",
  "redirect_urls": ["https://remote.helper.local/auth/callback"],
  "enabled_auth_methods": ["email", "google", "apple"],
  "user_scope": "global",
  "ui_theme": { /* minimal theme */ },
  "language_config": "en"
}
```

Signed with `REMOTE_UOA_SHARED_SECRET` (HS256).

### 2. User starts auth

The client (browser or mobile app) opens:

```
https://authentication.unlikeotherai.com/oauth/authorize
  ?config_url=https%3A%2F%2Fremote.helper.local%2Fauth%2Fuoa-config
```

UOA fetches the config, verifies it, renders the login UI, and on success
redirects to `REMOTE_UOA_REDIRECT_URL` with a `code` query parameter.

### 3. Code exchange

The remote server exchanges the code for an access/refresh pair:

```
POST https://authentication.unlikeotherai.com/auth/token
Authorization: Bearer <hash(domain + SHARED_SECRET)>
Content-Type: application/json

{ "code": "<oauth_code>" }
```

Response:

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<opaque>",
  "token_type": "Bearer",
  "expires_in": 1800,
  "refresh_token_expires_in": 2592000
}
```

### 4. Verify the access token

The remote server validates the JWT locally with `golang-jwt/jwt/v5`:

- Algorithm must be `HS256`.
- Signature verified against `REMOTE_UOA_SHARED_SECRET`.
- `exp` must be in the future.
- `aud` (if present) must match expected audience.
- Extract `sub`, `email`, optional `org` claims.

### 5. Map to internal principal

```
UOA sub        -> User.external_id
UOA email      -> User.email
UOA name       -> User.display_name
UOA org.roles  -> User.roles  (if present; MVP ignores)
```

The remote server then mints its **own** short-lived internal session
token (HS256 JWT, independent secret) for subsequent control-plane calls.
External UOA tokens are never forwarded to internal modules.

### 6. Single-user authorization gate

MVP policy (hardcoded, later moves to OPA):

```
allow  iff  token.sub == REMOTE_UOA_OWNER_SUB
```

Any authenticated UOA user whose `sub` does not match the configured owner
is rejected at the identity adapter boundary before any resource logic runs.

### 7. Refresh

Refresh tokens are opaque and must be stored server-side (encrypted at rest
in Postgres, never exposed to the browser). Refresh is performed via the
same `/auth/token` endpoint with grant type `refresh_token`.

### 8. Logout / revocation

```
POST https://authentication.unlikeotherai.com/auth/revoke
Authorization: Bearer <hash(domain + SHARED_SECRET)>
```

Triggered on explicit logout or on internal session revocation.

## Security notes

- `SHARED_SECRET` is the single most sensitive value in the system: it signs
  access tokens **and** is the client identity. It must be injected from a
  secret manager, not committed, not logged, not echoed in errors.
- The remote server is both an HMAC signer (for its config JWT) and an HMAC
  verifier (for access tokens). Because HS256 is symmetric, any attacker
  with this secret can impersonate the server **and** forge tokens. This is
  UOA's trust model; treat the secret accordingly.
- When UOA adds a JWKS/asymmetric signing option in the future, switch.
- Only trust `email_verified=true` (or equivalent) before mapping an email
  to the internal `email` field.

## References

- UOA repo: https://github.com/UnlikeOtherAI/UnlikeOtherAuthenticator
- UOA client integration section in the project README documents the
  `config_url` / `/auth/token` flow used above.
