# Team hostnames

Authoritative standard for serving a team at its own subdomain. `AGENTS.md`
carries the one-line invariant and points here; **this file is the rule**.

## The shape

```text
https://<team.slug>.<organisation.slug>.<base domain>
              e.g.  https://design.acme.nessie.works
```

Two labels, in that order, and the order is not cosmetic. **The organisation
label is the tenant key; the team label is only meaningful relative to it.**
UOA's Tenant Subdomain Contract (`Docs/brief.md`) states it directly: the
organisation slug is unique per client domain and is the canonical tenant DNS
label, while a team slug is unique only within its organisation and "must never
be used as a DNS tenant key".

So a flat `design.nessie.works` is **forbidden**, and not as a matter of taste:
team slugs are not unique across organisations, so the hostname would not
identify a team. Making them unique would mean machine-renaming every
organisation's default team but one — the opposite of an address somebody chose.

Two organisations may both own a `design` team. Neither can reach the other.

## UOA owns the labels; the product owns the domain

Nessie **stores no slug**. `Team` has no slug column and must not gain one.
Both labels belong to UOA, and Nessie reads them from the directory and resolves
them through UOA on demand. This is the same rule as every other piece of
identity: a local copy would become a second authority the moment UOA's value
changed.

What Nessie owns is the base domain, declared in one place:

```
NESSIE_TEAM_HOST_BASE_DOMAIN=nessie.works
```

Unset means this deployment does not route teams by hostname at all. Every
existing install is in that state until it opts in, and nothing below applies.

## Resolution is a lookup, never an authorization

`GET /api/hosts/resolve?host=` answers *which tenant a hostname means* and
nothing else. It grants no access. The client then runs the ordinary silent
team-switch with the ids it got back, and **that** is where membership is
checked — it fails closed for a team the person is not in.

Consequently:

- **A hostname is a request to look at a team, never a claim to be in one.**
  Someone typing another tenant's address gets their own session and a refused
  switch, not that tenant's data.
- **The `Host` header is not identity.** The API's lint rule against deriving
  identity from `x-forwarded-host` still stands; the hostname arrives as an
  explicit query parameter from the client asking about itself.

## Matching a hostname is a label comparison, never a suffix test

`https://design.acme.evil-nessie.works` ends with `nessie.works`. So does
`https://nessie.works.attacker.test`. Both must be refused, so every check —
CORS admission in `server-origin-policy.ts` and parsing in the resolve route —
splits on dots and requires **exactly two** legal DNS labels in front of the
base domain, over https, with no explicit port. `endsWith` is a bug here, and
the tests in `api/test/cors-origin.test.ts` exist to keep it one.

## The edge: one wildcard per organisation

This is the part with a standing operational cost, and it is per **organisation**,
not per team.

DNS wildcards match exactly one label. `*.nessie.works` covers
`acme.nessie.works` but **not** `design.acme.nessie.works`, and `*.*.nessie.works`
is not valid DNS. So each organisation needs its own record and its own
certificate:

| Per organisation | Why |
|---|---|
| DNS `*.<org>.nessie.works` → the host | a wildcard matches one label, so the base wildcard cannot reach two deep |
| TLS `*.<org>.nessie.works` | one certificate covers every team in that organisation, for ever |

**Use a per-organisation wildcard, not per-hostname on-demand TLS.** Let's
Encrypt allows roughly 50 certificates per registered domain per week, and
`nessie.works` is the registered domain — so per-hostname issuance puts that
ceiling on *team creation*, and the 51st team in a week gets a host that will not
serve TLS. A per-organisation wildcard moves the same ceiling to organisation
creation, which is rare. It also keeps team names out of Certificate
Transparency logs, since only the organisation label is published.

The cost of that choice: wildcards can only be issued over the DNS-01 challenge,
so the shared Caddy needs a DNS provider module — stock `caddy:2-alpine` has
none. Build it with `xcaddy` including `caddy-dns/cloudflare`, and give it a
zone-scoped Cloudflare token.

Operator steps live in
[docs/deployment/team-hosts.md](../deployment/team-hosts.md).

## Local development

Ports are unchanged and non-negotiable: API `5454`, admin `5455`.

Vite allows the whole `.localhost` tree, so `http://design.acme.localhost:5455`
exercises the real host-mode path. Chrome and Firefox resolve `*.localhost` to
loopback by themselves; **Safari does not** and needs an `/etc/hosts` line per
host you want to try.

Leave `NESSIE_TEAM_HOST_BASE_DOMAIN` unset locally unless you are specifically
working on host mode — with it unset, `/api/hosts/resolve` answers `null` and
the admin behaves exactly as it always has.
