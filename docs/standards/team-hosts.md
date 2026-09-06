# Team hostnames

Authoritative standard for serving a team at its own subdomain. `AGENTS.md`
carries the one-line invariant and points here; **this file is the rule**.

## The shape

```text
https://<organisation.slug>.<base domain>              the organisation portal
                     e.g.  https://acme.nessie.works

https://<team.slug>.<organisation.slug>.<base domain>  a team
              e.g.  https://design.acme.nessie.works
```

**One label under the base domain is an organisation, two is a team.** Both are
served by the same host-agnostic admin bundle, which resolves its own hostname
and switches into that tenant; there is no per-tenant build and no per-tenant
container.

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
splits on dots and requires **one or two** legal DNS labels in front of the
base domain, over https, with no explicit port. One is an organisation portal
and two is a team; anything else is refused. `endsWith` is a bug here, and the
tests in `api/test/cors-origin.test.ts` exist to keep it one.

Admission is a check on the hostname's *shape*, not on whether that tenant
exists: an origin under the base domain is admitted without a UOA round trip on
every preflight. That is safe only because control of any `*.nessie.works`
origin requires control of the zone — and a name with no certificate cannot
complete a TLS handshake, so no browser can ever originate from one.

## The edge: DNS is free, certificates are not

This is the part with a standing operational cost, and on the deployed estate
it is **per hostname** — not per organisation, as this file previously claimed.

### DNS needs nothing per tenant

RFC 1034 says a wildcard matches exactly one label, and that is what the
per-organisation record in the old version of this rule was written for.
**Cloudflare's authoritative DNS does not behave that way.** A single
`*.nessie.works` A record answers at any depth — verified against the zone's
own nameserver, where `a.b.c.nessie.works` resolves. One record covers every
organisation portal and every team address, for ever.

Confirm before relying on it if the zone ever moves to another provider: this
is provider behaviour, not a standard.

### Certificates need one line per hostname

Each hostname is listed explicitly in the shared Caddy config, and gets its own
certificate over HTTP-01. Three independent constraints force that, and any one
of them would be enough:

| Constraint | Consequence |
|---|---|
| A wildcard **certificate** can only be issued over DNS-01, and stock `caddy:2-alpine` carries no DNS provider module | a per-organisation wildcard would mean rebuilding the shared proxy with `xcaddy` |
| A Caddy wildcard **site address** (`*.nessie.works`) matches exactly one label | it can cover organisation portals but can never reach a two-label team host |
| `on_demand_tls.ask` is a **single global setting**, already claimed by another product on the same proxy | pointing it at Nessie would break that product's issuance |

The proxy fronts around forty products, so rebuilding it to serve one is not a
trade worth making today.

**What this costs.** Let's Encrypt allows roughly 50 certificates per
*registered* domain per week, and `nessie.works` is the registered domain — so
per-hostname issuance puts that ceiling on tenant creation, counted across the
whole zone. It also publishes team labels to Certificate Transparency, which a
per-organisation wildcard would not.

**And the gap it leaves: a newly created team's address does not serve until
somebody edits the Caddy config.** That is a real break in "a capability is not
done until a person can reach it", and it is open. Closing it means either a
dispatcher in front of the shared `ask` plus an endpoint that answers 200 only
for real tenants, or moving Nessie behind its own Caddy instance where the
global `ask` is Nessie's to spend. Revisit when tenant volume makes the edit a
burden, or when issuance approaches the weekly ceiling.

## The tenant's address is the tenant's brand

On a tenant hostname the product is not the brand — the tenant is. Three rules
follow, and they are the reason the hostname is resolved server-side before the
page renders at all.

**An organisation portal shows the organisation; a team address shows a way
in.** Signed out, both render the organisation's mark, its name, and the
address, with a single sign-in action. Signed in, the portal lists **the teams
that person belongs to, read from their own session** — never derived from the
hostname, so a guessable address can never become a directory of a customer's
internal structure. A team address never names its team to an anonymous
visitor, which is why `/api/hosts/team` is authenticated while
`/api/hosts/resolve` is public.

**The organisation's palette follows the address.** This is the deliberate
exception to "the sign-in screen is instance state, not tenant state"
(`docs/plans/2026-09-05-organisation-custom-theme.md` §4.3). That rule holds
because the shared login cannot know whose visitor it has, and one tenant must
not choose it for the rest — neither is true of a hostname that names the
organisation and reaches only its own address. `app.nessie.works` stays neutral
and §4.3 still governs it. An explicit theme choice still beats the
organisation's, unchanged.

**Sign-in happens on the canonical origin, and comes back.** A tenant hostname
can never be a registered OAuth redirect target: UOA matches redirect URLs
byte-for-byte and these hostnames are created at runtime. So the visitor is
handed to the product's canonical origin carrying a `return`, and returned
afterwards. Because that address arrives in a URL, it is checked twice before
it is ever stored — its shape (https, no credentials, not this origin), and
then `/api/hosts/resolve`, which answers only for hostnames that really are
tenants of this deployment. Never trust the parameter alone.

## Local development

Ports are unchanged and non-negotiable: API `5454`, admin `5455`.

Vite allows the whole `.localhost` tree, so `http://design.acme.localhost:5455`
exercises the real host-mode path. Chrome and Firefox resolve `*.localhost` to
loopback by themselves; **Safari does not** and needs an `/etc/hosts` line per
host you want to try.

Leave `NESSIE_TEAM_HOST_BASE_DOMAIN` unset locally unless you are specifically
working on host mode — with it unset, `/api/hosts/resolve` answers `null` and
the admin behaves exactly as it always has.
