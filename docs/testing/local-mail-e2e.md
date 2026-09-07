# Local mail transport smoke test

Start the isolated GreenMail service from the repository root:

```powershell
docker compose -f infrastructure/compose/docker-compose.mail-e2e.yml up -d
node scripts/local-mail-e2e.mjs
```

It publishes only to loopback: SMTP on `3025`, IMAP on `3143`, SMTPS on
`3465`, and IMAPS on `3993`. Its test-only accounts are
`agent@nessie.test` and `recipient@nessie.test`; their protocol usernames are
`agent` and `recipient`, both with password `mail-e2e-only`.

The smoke test authenticates over SMTP, delivers one message, then authenticates
over IMAP and proves the recipient inbox contains it. It is a wire-transport
test, not a Nessie production-client test: the daemon's local test certificate
is not a production trust anchor, and connected-mail production code
deliberately rejects loopback endpoints through its egress guard. App tests that
need this daemon must inject their test transport at the protocol boundary; no
environment switch weakens the production guard.

Stop the service when it is no longer needed:

```powershell
docker compose -f infrastructure/compose/docker-compose.mail-e2e.yml down
```
