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

## The address bar follows the switch — in a browser only

Every place that moves the page between tenants decides where to go through
one module, `admin/src/lib/tenant-navigation.ts`, and must keep doing so —
`admin/test/tenant-navigation.test.ts` pins each entry point to it:

| Entry point | Browser | Native shell |
|---|---|---|
| `TeamSwitcher` (rail / menu switch) | team's address from `GET /api/hosts/address?teamId=` when it is a different host; on the canonical origin with no address, in-app `/channels`; on a tenant host with no address, the canonical origin carrying the team | in-app `/channels` on the canonical origin; the address is not even looked up |
| `OrgPortal` (team picked on `<org>.<base>`) | team's address; if there is none, the canonical origin carrying the team; if neither is known, stays on the portal | the canonical origin carrying the team |
| `TenantReturnHandoff` (stored `?return=` after sign-in) | the stored tenant address | dropped: forgotten and not followed, so the person stays on the canonical origin |

**No tenant host keeps a team that is not its own.** A team address serves the
app, so staying there once looked like the cheap answer, and it was the defect:
switching teams on `general.kilomayo.nessie.works` left that URL over another
organisation's channels, a copied link sent a colleague to the wrong place, and
the next load of the address switched the session back. The canonical origin is
different — it serves every team — so there it stays and routes.

**Not every team has an address to go to instead**, and that is the reason the
paragraph above needs the handoff below rather than just "follow the address".

### A team with no address leaves for the canonical origin, carrying the team

Every lookup behind a tenant hostname — `/api/hosts/resolve`, the
`tls-check` gate, `/api/hosts/address` — is a UOA `/domain/*` read, and those
are scoped to this deployment's own UOA client domain (`UOA_DOMAIN`, in
production `api.nessie.works`). A person's teams are not: `/org/me` lists every
organisation they belong to, including ones founded on **another product's**
client domain.

So a team can be in the picker and have no address here at all. Measured
against production, an organisation on another domain resolves `kind: null`,
and `<team>.<that org>.nessie.works` does not complete a TLS handshake —
`tls-check` refuses, so no certificate is ever issued for it. **A hostname
built from UOA's labels alone is a dead link, not a shortcut**, which is why
`admin/src/lib/tenant-team-handoff.ts` and `api/src/services/landing-teams.ts`
both treat *the address lookup answering* as the test of whether an address
exists, rather than the labels in the directory.

Those switches go to the canonical origin, which serves every team, and carry
the team in the URL:

```text
https://app.nessie.works/channels?switchOrg=<uoa org id>&switchTeam=<uoa team id>
```

`TeamHandoffGate` runs the ordinary silent switch with those ids, then reloads
the stripped address. **The ids are a request, never a grant** — exactly like a
hostname, and for the same reason: the switch behind them is
`POST /api/auth/uoa/team`, which re-checks live membership and fails closed.
Somebody hand-writing another tenant's ids gets their own session and a refused
switch, so there is nothing to sign and nothing to forge. Both ids are shape-
checked before they become a request, which keeps a truncated copy or a probe
from reaching the switch at all.

The reload after a successful switch is not decoration: a switch replaces the
tenant context wholesale, and a fresh document is the only state guaranteed to
hold no query cached under the previous team.

**A native shell never loads a tenant hostname as its top-level document.**
`isNativeShell()` is `isDesktopApp()` or `isReactNativeWebView()`. The desktop
shell grants IPC only to `https://app.nessie.works/**`
(`desktop/src-tauri/capabilities/default.json`), so a tenant hostname as its
top-level document loses the deep-link bridge: `ExternalAuthProvider` then
toasts "The external sign-in could not be completed." while the UI stays on the
old team. Tenant hostnames remain unsupported as a desktop top-level document;
widening that allowlist is a separate security decision, not a fix for this.
**A native shell that is already on a tenant hostname leaves it.** The entry
points above are not the only way a document gets there — a link opened in the
window or an older bundle can still land one — and on that host every IPC call
is refused: on macOS the overlay title bar stops dragging the window, because
`data-tauri-drag-region` works by invoking `start_dragging`. `TenantHostGate`
therefore asks `nativeShellRecoveryHref` once the hostname resolves and
`location.replace`s to the canonical origin: the same path from a team host,
`/channels` from an organisation portal. It renders nothing and runs no team
switch meanwhile; the canonical origin opens on the session's current team.
A stored tenant return is dropped rather than converted into an in-app switch:
the ids behind a return address are not known without another lookup, and the
signed-in canonical origin is already a complete place to land.

**An organisation portal never navigates in-app.** `TenantHostGate` renders
`OrgPortal` for an organisation hostname whatever the path, so `/channels` on
that host reloads the portal instead of opening the team.

**Known gap, browsers only:** accepting an invitation
(`admin/src/facades/team/invitations.ts`) and creating a team
(`admin/src/facades/team/provisioning.ts`) still navigate in-app and do not
follow the new team's address. Native shells are unaffected.

**A team host renders nothing until the address and the session agree.**
Firing the switch and rendering the app underneath it was the second half of
the same defect: the routes below began fetching in the previous team's scope,
and a switch that then failed — silently, because the rejection was swallowed —
left the previous team's channels, projects and search on screen under a URL
naming a different team. `TenantHostGate` now holds the router while the ids
and the switch are in flight, and renders a refusal, branded and naming no
team, when the switch is refused. It never falls through to the previous team.

**A team host does not re-switch onto the team the session is already on.**
`TenantHostGate` compares the host's `externalOrgId`/`externalTeamId` with the
active `me.uoaTeams` entry (`tenantTeamSwitchNeeded`) and switches only when
they differ. A redundant `POST /api/auth/uoa/team` races the page-load refresh,
which rotates the same refresh-cookie family, and loses with
`TEAM_SWITCH_CONFLICT`.

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

## The edge: DNS is free, team certificates are automatic

Creating a team makes its address work with no edge change. Founding an
organisation still needs one line, for a reason that cost an outage to learn.

### DNS needs nothing per tenant

RFC 1034 says a wildcard matches exactly one label, and that is what the
per-organisation record in the old version of this rule was written for.
**Cloudflare's authoritative DNS does not behave that way.** A single
`*.nessie.works` A record answers at any depth — verified against the zone's
own nameserver, where `a.b.c.nessie.works` resolves. One record covers every
organisation portal and every team address, for ever.

Confirm before relying on it if the zone ever moves to another provider: this
is provider behaviour, not a standard.

### Teams are issued on demand; organisations are not

The tenant configuration is deliberately two blocks, and the split is a
measured constraint rather than a preference.

```
nessie-works.nessie.works,        # organisations: one line each
kilomayo.nessie.works { ... }

*.*.nessie.works {                # teams: nothing is listed
	tls { on_demand }
	...
}
```

**Creating a team makes its address work.** Nobody edits the edge. On the first
TLS handshake for a name Caddy has not seen, it asks whether that tenant exists
and issues over HTTP-01 if so. Measured on the live proxy: **2.95 s** for the
first visit to a hostname with no certificate, **0.15 s** for the next one.

**Creating an organisation still needs a line here.** That is the part that
cannot be automated, and the reason is worth reading before anyone tries again.

#### `*.nessie.works` with `on_demand` breaks the product's own hosts

Do not add it. With such a block present, the handshake for `api.nessie.works`
fails — `tlsv1 alert internal error` — even though `api` has its own site
block, its own `tls` policy, and appears in Caddy's managed-certificate list.
**This took the production API down for about two minutes on 2026-09-06.**

It is not an ordering problem and not a missing policy. Against an isolated
Caddy, all of these still failed:

| Attempted fix | Result |
|---|---|
| Rely on the explicit `api.nessie.works` block winning | fails |
| Give the named block its own `tls { issuer ... }` policy | fails |
| Have the gate answer **yes** for `api.nessie.works` | fails |

A control with the wildcard block removed served `api.nessie.works` normally,
so the wildcard is the cause: its automation policy captures its siblings.

`*.*.nessie.works` has no such problem, because **every hostname this product
serves itself is one label** — `api`, `app`, `www`. A two-label wildcard cannot
collide with any of them, and a Caddy site-address wildcard matches exactly one
label (also measured: `*.nessie.works` matched `acme.nessie.works` and not
`design.acme.nessie.works`; neither matched three labels).

So organisation portals keep one line each. An organisation is founded far less
often than a team is created, which is why this is the acceptable half.

#### The gate is `GET /api/hosts/tls-check`, and it is stricter than resolution

Wiring the edge to `/api/hosts/resolve` would be the obvious shortcut and a
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

So the gate verifies the team, answers `204` or a bare `404` and nothing else,
and treats UOA being unreachable as no. Confirmed against production: real
tenants `204`; `totally-made-up.nessie-works.nessie.works` `404` and no
certificate minted for it.

#### The product's own hostnames are never tenants

`app`, `api`, `www` and this deployment's other labels are refused by
`parseTenantHost` before UOA is asked. UOA reserves them as organisation slugs
too, and that is the primary defence — but the hostnames being protected are
**ours**, and a security property of this product should not depend on a list in
another repository.

What it prevents: if such a label ever resolved to an organisation, the host
gate would render that tenant's portal **in place of the product on its own
canonical origin**, and this gate would tell the edge the name deserved a
certificate. A label added to the deployment later — a status page, a docs host
— belongs in that set, and in the edge config, before it is used.

#### And it is authenticated, by `NESSIE_TLS_CHECK_KEY`

The question it answers is *does this team exist* — which this product
deliberately keeps behind authentication. `/api/hosts/team` is authenticated
and the branded team page never names its team, precisely so a guessable
address cannot be confirmed. An open gate would hand that back through the side
door, so the edge presents a shared secret.

**In a header, `X-Nessie-TLS-Check-Key`, never in the query string.** It rode in
the URL when this shipped, and request logging records URLs: the secret was
written in clear text into this API's logs on every ask. Found by a security
review, confirmed on the running system, and the reason the rule is absolute — a
secret in a URL is a secret in a log.

Every failure refuses, not only the one error class the handler used to name. An
unhandled throw becomes a 500, and a 500 is a refusal a caller can tell apart
from the others, which defeats the point of making them identical.

**Unset means the gate refuses everything.** An install that has not configured
it cannot be turned into an existence oracle, and on-demand issuance simply
does not happen there — the right default for every deployment that does not
route tenants by hostname.

#### One `ask` endpoint, two products

`on_demand_tls.ask` is a **single global setting** on a proxy fronting around
forty products, and another product already owned it. It now points at a
dispatcher — a loopback-only site block in the same Caddy — which routes by the
`domain` being asked about and forwards anything that is not ours to the
endpoint that had it before. Nessie must never take that setting for itself.

The dispatcher lives inside Caddy rather than in a container of its own on
purpose: if Caddy is down nothing is being served anyway, so it adds no failure
mode. A separate container would add one, and it would fall on the *other*
product. It was checked against the previous owner's endpoint domain by domain
before the switch, and answered identically every time.

The key is forwarded on the Nessie branch only; the other product neither needs
nor should see it.

Two things the dispatcher must keep doing, both found by review after the first
version shipped without them:

- **Match case-insensitively and tolerate a trailing dot.** SNI is not
  guaranteed lowercase and an FQDN may carry the root dot. The first regex
  (`~\.nessie\.works$`) missed both, which sent a *nessie.works* name to the
  other product's gate to be decided — an availability bug in that direction,
  and not a trade to leave to luck. The apex is now classified explicitly and
  refused here rather than falling through.
- **Bound the upstream.** `dial_timeout` and `response_header_timeout` on the
  Nessie branch: without them a slow-but-up API holds the TLS handshake open
  inside the single Caddy process that fronts every other product here. A
  timeout is a refusal, which is the safe direction. Measured, the gate answers
  in 40–70 ms, so the limits sit nowhere near the healthy path.

#### Known, and not closed: issuance rate

`tls-check` stops *fake* names, but nothing bounds issuance for **real** ones.
Someone able to create teams cheaply could mint enough certificates to exhaust
Let's Encrypt's weekly allowance for the whole of `nessie.works` — a denial of
service against every tenant, not only their own.

It is unpatched because neither obvious fix is right alone: Caddy's
`on_demand_tls` limiter is global and would throttle the other product sharing
this proxy, and a per-organisation budget needs issuance state this product does
not keep. Design it before building it.

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

## The landing lists the teams you are signed into

`https://nessie.works` (`web/`) opens, for a signed-in visitor, with a "Your
teams" section before everything else: every team the person belongs to, its
organisation, its avatar, and which one the session is on. Signed out, the
section does not exist — no placeholder, nothing that moves.

**The read is `GET /api/auth/landing-teams`, and it admits only the landing's
own origins.** It lives under `/api/auth` because that is the refresh cookie's
path. `NESSIE_LANDING_ORIGIN` is an exact-match list — production is
`https://nessie.works,https://www.nessie.works`, because the landing answers on
both — validated at config load: every entry must be a bare `http(s)` origin,
and a path or malformed entry refuses to start. The route echoes
`Access-Control-Allow-Origin` with the one listed origin the request came from,
never `*` and never the list, keeps `Vary: Origin, Cookie`, and refuses every
other `Origin` with a 403 — the app, tenant hosts and lookalikes such as
`https://nessie.works.evil.com` included. The landing is deliberately **not** in
`NESSIE_CORS_ORIGINS`: that list grants every credentialed route, and this page
needs one answer. Unset means no landing is admitted and the section never
renders.

**It reads the refresh session without consuming it.** The cookie is shared
with the app; rotating it here would race the app's page-load refresh on the
same family, the failure the section above already avoids. A revoked,
expired, rotated-away or unbindable session answers `200 { teams: [] }`, the
same as no cookie, so anonymous traffic produces no errors.

**The list is the one `/api/auth/me` serves.** Under UOA it is
`loadUoaTeamDirectory` — the bounded in-memory directory, freshness read and
cold-cache fallback — so nothing new is stored. Each entry links to the team's
address from the same UOA lookup `/api/hosts/address` uses, at `/channels`,
where `TenantHostGate` runs the ordinary silent switch; with no address it
links to the app's canonical origin (`NESSIE_ADMIN_PUBLIC_URL`). Without an
IdP the teams are the local membership tree and the active one is the first
membership, which is the team a refresh of that session lands on.

**The wire carries only what is drawn** — label, organisation name, avatar URL,
active flag, link (`LandingTeamSchema`); no ids, no email. Rate limited by
`landingTeamsIp` (docs/rate-limiting.md). The landing's CSP names
`https://api.nessie.works` in `connect-src` and UOA's host in `img-src`.

**Known gap, and why it stays one:** a team with no resolvable address that is
not the active one opens the app on the session's current team; the person
switches from there. The app's own entry points close this with the
`?switchOrg=/?switchTeam=` handoff above, and the landing deliberately does
not use it. `LandingTeamSchema` carries only what the section draws — no ids —
because the landing is a different origin, and a handoff link would write two
UOA ids into that origin's URLs, its access logs and anything measuring it.
Closing this properly means the landing asking the API for a link, not the API
volunteering the ids. Native shells are unaffected: the landing is a browser
page and never runs inside them.

## Local development

Ports are unchanged and non-negotiable: API `5454`, admin `5455`.

Vite allows the whole `.localhost` tree, so `http://design.acme.localhost:5455`
exercises the real host-mode path. Chrome and Firefox resolve `*.localhost` to
loopback by themselves; **Safari does not** and needs an `/etc/hosts` line per
host you want to try.

Leave `NESSIE_TEAM_HOST_BASE_DOMAIN` unset locally unless you are specifically
working on host mode — with it unset, `/api/hosts/resolve` answers `null` and
the admin behaves exactly as it always has.
