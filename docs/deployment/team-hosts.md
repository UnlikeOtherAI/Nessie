# Serving teams at their own subdomains

Operator guide. The rule and its reasoning are in
[docs/standards/team-hosts.md](../standards/team-hosts.md); this is the runbook.

Nothing here is required unless you are turning team hostnames on. With
`NESSIE_TEAM_HOST_BASE_DOMAIN` unset, the feature is inert.

## Once, for the deployment

### 1. DNS

One wildcard covers every organisation host:

```bash
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY" \
  -H 'content-type: application/json' \
  --data '{"type":"A","name":"*","content":"178.105.82.46","proxied":false}'
```

`proxied:false` matters — Caddy needs to see the real connection to answer the
HTTP-01 challenge. Specific records (`api`, `app`, `www`) still win over the
wildcard, so nothing existing moves.

A DNS wildcard matches exactly one label, so `*.nessie.works` covers
`acme.nessie.works` but **not** `design.acme.nessie.works`. Team hosts need a
`*.<org>.nessie.works` record per organisation.

### 2. Caddy — named hosts, no rebuild

**Stock `caddy:2-alpine` is enough.** Certificates are issued per hostname over
HTTP-01, which needs no DNS provider module. This was verified on the shared
edge: `tenant-test.nessie.works` was issued a Let's Encrypt certificate
(`CN=tenant-test.nessie.works`) within seconds of the site block being added,
with no change to the Caddy image.

Add hostnames to the `# === Nessie tenant hosts ===` block:

```caddyfile
acme.nessie.works, design.acme.nessie.works {
	encode zstd gzip
	reverse_proxy nessie-admin:80 {
		header_up Host {host}
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-For {remote_host}
	}
}
```

Then validate before reloading — this proxy fronts ~72 site blocks for other
products, and a malformed file takes all of them down:

```bash
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

**Do not reach for `xcaddy` + `caddy-dns/cloudflare` unless volume forces it.**
Wildcard certificates can only be issued over DNS-01, which is the only reason
that rebuild would be needed — and rebuilding the shared edge risks every other
product on the box. The single thing it buys is escaping Let's Encrypt's ~50
certificates per registered domain per week, counted across all of
`nessie.works`. Named hosts spend one certificate per tenant hostname, so that
ceiling only bites in the hundreds of tenants.

### 3. Tell the API its base domain

```
NESSIE_TEAM_HOST_BASE_DOMAIN=nessie.works
```

This is what turns the feature on: it makes `/api/hosts/resolve` answer, and
admits `https://<org>.nessie.works` and `https://<team>.<org>.nessie.works` as
CORS origins — by label comparison, so a look-alike domain ending in the same
string is still refused.

### 4. Declare the product's hostnames to UOA

In the signed config Nessie serves at `/api/auth/sso/config`:

```json
"hostnames": {
  "team_base_domain": "nessie.works",
  "reserved_labels": ["nessie", "app", "api", "vault", "ledger"]
}
```

`reserved_labels` are added to UOA's base list and cannot subtract from it, so
no tenant can take a label the product answers on. **A config change only takes
effect once the product redeploys and serves the new JWT.**

## Per organisation

Two things, both once per organisation, both covering every team inside it for
ever.

### DNS

```bash
# *.acme.nessie.works -> the host
curl -sS -X POST \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"type":"A","name":"*.acme","content":"178.105.82.46","proxied":false}'
```

`proxied:false` matters: DNS-01 issuance needs the record to resolve to the
origin.

### Caddy

Add the organisation host, and each team host, to the tenant block by name —
see "Caddy — named hosts" above. No `tls` stanza is needed: HTTP-01 issues
automatically for a named host.

Then validate and reload, exactly as for any other site block:

```bash
docker exec infra-caddy caddy validate --config /etc/caddy/Caddyfile
docker exec infra-caddy caddy reload --config /etc/caddy/Caddyfile
```

## Why not simply `*.nessie.works`

Because a DNS wildcard matches exactly one label, and `*.*.nessie.works` is not
valid DNS. `*.nessie.works` covers `acme.nessie.works` and stops there.

## Why not on-demand TLS

The shared edge already has `on_demand_tls` configured globally, but its `ask`
endpoint belongs to another product (`landscaper-app`). `on_demand_tls.ask` is a
single global setting, so using on-demand for Nessie would mean another
product's endpoint deciding which Nessie hostnames may exist. Named hosts avoid
that coupling entirely.

## Checks

```bash
# resolves to the host
dig +short design.acme.nessie.works

# certificate covers the wildcard, not the single name
echo | openssl s_client -connect design.acme.nessie.works:443 \
  -servername design.acme.nessie.works 2>/dev/null \
  | openssl x509 -noout -text | grep -A1 'Subject Alternative Name'
```

Then open `https://design.acme.nessie.works` signed in: you should land in that
team without touching the picker. Opening a team you are not a member of should
leave you in your current team — resolution is a lookup, and the switch that
follows is the check.
