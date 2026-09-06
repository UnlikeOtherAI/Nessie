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

## The edge: DNS is free, certificates are issued on demand

Creating a team makes its address work. Nobody touches the edge, and the
sections below are the reasons that is safe rather than merely convenient.

### DNS needs nothing per tenant

RFC 1034 says a wildcard matches exactly one label, and that is what the
per-organisation record in the old version of this rule was written for.
**Cloudflare's authoritative DNS does not behave that way.** A single
`*.nessie.works` A record answers at any depth — verified against the zone's
own nameserver, where `a.b.c.nessie.works` resolves. One record covers every
organisation portal and every team address, for ever.

Confirm before relying on it if the zone ever moves to another provider: this
is provider behaviour, not a standard.

### Certificates are issued on demand, gated by this product

A tenant hostname is **not** listed in the edge config. The tenant block is two
wildcards —

```
*.nessie.works, *.*.nessie.works
```

— with `tls { on_demand }`. Caddy's site-address wildcard matches exactly one
label (verified, not assumed: `*.nessie.works` matched `acme.nessie.works` and
not `design.acme.nessie.works`, and neither matched three labels), so the pair
covers an organisation portal and a team address and nothing deeper.

On the first TLS handshake for a hostname it has never seen, Caddy asks whether
that name may exist, and issues over HTTP-01 only if the answer is 2xx. **The
first visitor to a brand-new address waits a second or two inside the
handshake; every visit after that is served from cache.** Nobody edits config,
which is what makes a created team reachable — rule zero.

#### The gate is `GET /api/hosts/tls-check`, and it is stricter than resolution

Wiring the edge to `/api/hosts/resolve` would be the obvious shortcut and is a
serious bug. Two reasons, either one sufficient:

- It answers **200 with `kind: null`** for a hostname it does not recognise.
  Caddy reads any 2xx as yes, so every name anyone ever tried would get a
  certificate.
- For a team hostname it verifies only the **organisation** label, because a
  branded page for `<anything>.acme.nessie.works` is harmless — it shows Acme's
  mark and a sign-in button. A certificate is not harmless. Let's Encrypt
  allows roughly 50 per registered domain per week, counted across the whole of
  `nessie.works`, so a made-up team label that earned one would let anybody
  exhaust issuance **for every tenant at once**.

So the gate verifies the team, answers `204` or `404` and nothing else, and
treats UOA being unreachable as no.

#### And it is authenticated, by `NESSIE_TLS_CHECK_KEY`

The question it answers is *does this team exist* — which this product
deliberately keeps behind authentication. `/api/hosts/team` is authenticated
and the branded team page never names its team, precisely so a guessable
address cannot be confirmed. An open gate would hand that back through the side
door, so the edge presents a shared secret in the ask URL.

**Unset means the gate refuses everything.** An install that has not configured
it cannot be turned into an existence oracle, and on-demand issuance simply
does not happen there — which is the right default for every deployment that
does not route tenants by hostname.

#### One `ask` endpoint, two products

`on_demand_tls.ask` is a **single global setting** on a proxy fronting around
forty products, and another product already owns it. It is therefore pointed at
a dispatcher — a loopback-only site block in the same Caddy — which routes by
the `domain` it is asked about and forwards everything that is not ours to the
endpoint that had it before. Nessie must never take that setting for itself.

The dispatcher lives inside Caddy rather than in a container of its own on
purpose: if Caddy is down nothing is being served anyway, so it adds no failure
mode. A separate container would add one, and it would fall on the *other*
product.

#### What this still costs

Issuance is per hostname, so the weekly ceiling now applies to tenant creation,
counted across the whole zone. Team labels also reach Certificate Transparency,
which a per-organisation wildcard would have avoided; that remains the reason
to revisit `xcaddy` + `caddy-dns/cloudflare` if tenant volume ever grows enough
to matter.

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
