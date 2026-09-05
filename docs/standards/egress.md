# Outbound egress — IP-pinned, not just validated

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md) so
it is read when the work touches networking code rather than loaded into every
session. `AGENTS.md` → "Architecture" carries the one-line summary and points
here; **this file is the rule.**

Validating a URL and then calling plain `fetch` leaves a DNS-rebinding window
between the check and the socket. Use `@nessie/runtime` `safeFetch` (or
`pinnedFetch` when you handle redirects yourself) for anything reaching a
caller-, operator- or model-supplied address: it resolves once, pins the
connection to the vetted IPs, re-checks each address as it dials, and
re-validates every redirect hop. `assertSafeUrl` alone is only enough where
nothing is fetched afterwards.

Current callers: MCP OAuth exchange/refresh/discovery/registration, the MCP
SDK HTTP+SSE transports, FCM `token_uri`, `web_fetch` and `http_fetch`.
Inference provider `baseUrl` is validated at write time as well as use time.

The gate is mechanical: the egress block in the root `eslint.config.js` bans
global `fetch` (call, value, `globalThis`/`window`, `typeof fetch`) and raw
`node:http(s)` imports across `api/src`, `worker/src`, `packages/*/src`,
`executor/src`, `cli/src` and `gateway/src`, with test trees excluded and a
per-entry-justified allowlist that only shrinks — admission criteria sit in
the block comment (Workstream 3d of
[docs/plans/2026-08-13-security-boundary-hardening.md](../plans/2026-08-13-security-boundary-hardening.md);
the lint is the ratchet, the branded transport remains the boundary).

Raw sockets get the same policy through the same rules rather than a second
copy of them: `resolveVettedAddresses` is the shared host check, and the
IMAP/SMTP dialer (`packages/agent-mail/src/dial.ts`) calls it on every dial,
then connects to the returned literal address — there is no second resolution
to rebind — with TLS verified against the configured hostname, not the
address.

See [docs/security-audit-2026-06.md](../security-audit-2026-06.md).
