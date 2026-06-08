# Nessie Gateway

`@nessie/gateway` is the vendor-operated push relay for the published Nessie
mobile app. Self-hosted Nessie instances will call this service in a later
round; this package does not modify the worker, API, or live production compose.

## HTTP API

### `GET /health`

Returns:

```json
{ "ok": true }
```

### `POST /v1/push`

Requires:

```http
Authorization: Bearer <GATEWAY_API_KEY>
```

Request:

```json
{
  "targets": [
    { "token": "apns-or-fcm-token", "platform": "ios" }
  ],
  "payload": {
    "title": "Mention",
    "body": "Ada mentioned you",
    "badge": 3,
    "data": { "deepLink": "nessie://channels/123" },
    "collapseId": "channel-123"
  }
}
```

Response:

```json
{
  "results": [
    { "token": "apns-or-fcm-token", "ok": true, "deadToken": false }
  ]
}
```

If APNs or FCM credentials are absent, targets for that provider return a
per-target `"APNs is not configured"` or `"FCM is not configured"` error.

## Environment

Required for the service:

- `GATEWAY_API_KEY` - bearer token accepted by `POST /v1/push`.

Optional bind settings:

- `GATEWAY_HOST` - listen host, default `0.0.0.0`.
- `GATEWAY_PORT` or `PORT` - listen port, default `5556`.

APNs is configured only when all of these are present:

- `PUSH_APNS_P8` - `.p8` contents, escaped-newline contents, or a file path.
- `PUSH_APNS_KEY_ID` - Apple key id.
- `PUSH_APNS_TEAM_ID` - Apple developer team id.
- `PUSH_APNS_TOPIC` - app bundle id.
- `PUSH_APNS_ENV` - `sandbox` or `production`.

FCM is configured when this is present:

- `PUSH_FCM_SERVICE_ACCOUNT` - Firebase service-account JSON string.

Credentials are loaded and validated at startup. Present-but-incomplete provider
configuration is a startup error; entirely absent provider configuration leaves
the service running and returns a per-target not-configured result.

## Build And Run

```sh
pnpm --filter @nessie/push build
pnpm --filter @nessie/gateway build
pnpm --filter @nessie/gateway start
```

## Compose Snippet For Later

The live production compose is deliberately unchanged in this round. A later
integration can add a service like:

```yaml
nessie-gateway:
  build:
    context: ../..
    dockerfile: infrastructure/docker/Dockerfile.gateway
  environment:
    GATEWAY_API_KEY: ${GATEWAY_API_KEY}
    PUSH_APNS_P8: ${PUSH_APNS_P8}
    PUSH_APNS_KEY_ID: ${PUSH_APNS_KEY_ID}
    PUSH_APNS_TEAM_ID: ${PUSH_APNS_TEAM_ID}
    PUSH_APNS_TOPIC: ${PUSH_APNS_TOPIC}
    PUSH_APNS_ENV: production
    PUSH_FCM_SERVICE_ACCOUNT: ${PUSH_FCM_SERVICE_ACCOUNT}
  ports:
    - "5556:5556"
```
