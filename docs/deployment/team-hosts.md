# Serving teams at their own subdomains

Operator guide. The rule and its reasoning are in
[docs/standards/team-hosts.md](../standards/team-hosts.md); this is the runbook.

Nothing here is required unless you are turning team hostnames on. With
`NESSIE_TEAM_HOST_BASE_DOMAIN` unset, the feature is inert.

## Once, for the deployment

### 1. Caddy needs a DNS provider module

Team hostnames are two labels deep, so they need per-organisation **wildcard**
certificates, and a wildcard can only be issued over the DNS-01 challenge.
Stock `caddy:2-alpine` cannot do DNS-01 — it has no provider module — so the
shared edge has to be rebuilt with one:

```dockerfile
FROM caddy:2-builder-alpine AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

### 2. A zone-scoped Cloudflare token

Create an API token limited to the `nessie.works` zone with **Zone:DNS:Edit**.
Nothing wider — this token can write DNS for whatever it can reach.

Put it in the host env file (`/srv/nessie/infrastructure/compose/.env`, not
committed) as `CLOUDFLARE_API_TOKEN`, and pass it to the Caddy container.

### 3. Tell the API its base domain

```
NESSIE_TEAM_HOST_BASE_DOMAIN=nessie.works
```

This one variable turns the feature on. It makes `/api/hosts/resolve` answer,
and it admits `https://<team>.<org>.nessie.works` as a CORS origin — by label
comparison, so a look-alike domain ending in the same string is still refused.

### 4. Declare the product's hostnames to UOA

In the signed config Nessie serves at `/api/auth/sso/config`, add:

```json
"hostnames": {
  "team_base_domain": "nessie.works",
  "reserved_labels": ["nessie", "app", "api", "vault", "ledger"]
}
```

`reserved_labels` are added to UOA's base list and cannot subtract from it, so
no tenant can take a label the product answers on. **A config change only takes
effect once the product redeploys and serves the new JWT** — see
`Docs/deployment.md` in UOA.

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

```caddyfile
*.acme.nessie.works {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
	reverse_proxy nessie-admin:80
}
```

Then validate and reload, exactly as for any other site block:

```bash
docker exec infra-caddy caddy validate --config /etc/caddy/Caddyfile
docker exec infra-caddy caddy reload --config /etc/caddy/Caddyfile
```

## Why not simply `*.nessie.works`

Because a DNS wildcard matches exactly one label, and `*.*.nessie.works` is not
valid DNS. `*.nessie.works` covers `acme.nessie.works` and stops there.

## Why not per-hostname on-demand TLS

Let's Encrypt allows roughly **50 certificates per registered domain per week**,
and the registered domain is `nessie.works` — one bucket for the whole estate.
Issuing per team hostname puts that ceiling on team creation, and the failure is
ugly: the 51st team created in a week gets an address that does not serve TLS.

A per-organisation wildcard moves the ceiling onto organisation creation, which
is rare, and publishes only the organisation label to Certificate Transparency
rather than every team name.

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
