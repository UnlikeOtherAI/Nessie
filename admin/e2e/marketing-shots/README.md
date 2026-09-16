# Marketing screenshots

Every picture on nessie.works, cut out of the running product by one command.

Before this existed, three files rotated through all fifteen slots on the
homepage and none of them showed what the copy beside it claimed — the open
item at the top of
[the marketing handover](../../../docs/plans/2026-09-14-marketing-site-handover.md).

## Taking them

```bash
DATABASE_URL=postgresql://… pnpm --filter @nessie/admin shots
```

It starts this checkout's API and admin, seeds
[the fixture organisation](fixture.mjs), walks [the manifest](manifest.mjs) and
writes `web/public/screenshots/`. Add names to capture only those:

```bash
DATABASE_URL=… pnpm --filter @nessie/admin shots teamwork-handoff control-audit
```

## The two kinds of shot

**Window** — the three hero images. They are painted into the 3D desktop's
screen texture (`web/src/home/desktop3d.tsx`), so they are whole-window,
opaque and 16:10. The bezel does the rounding.

**Element** — the twelve pillar rows. These are cut out with the rounded edge
and the drop shadow **in the file's alpha channel**, because the same image
sits on white in one section and on navy in another; a CSS radius over an
opaque rectangle shows a hard corner against the darker band, and a CSS
`box-shadow` on a transparent rounded PNG leaks past the corners.

The cut works because Chromium composites an element screenshot over whatever
is painted behind it. So [`capture.mjs`](capture.mjs) clears every ancestor's
paint, hides every sibling at every level (the clip is wider than the element,
to hold the shadow), pins the element's inherited background onto itself,
rounds it, applies the shadow as a `filter` — which follows the alpha shape
rather than the box — and screenshots a padded clip with `omitBackground`.

Then it reads the pixels back ([`alpha.mjs`](alpha.mjs)): the outer corner must
be clear, the middle solid, the rounded corner partly transparent, and the
shadow margin neither. Transparency is the deliverable and a rendered thumbnail
cannot show it, so the run asserts on pixels instead of trusting the picture.

## The database

[`fixture.mjs`](fixture.mjs) builds the organisation — three named agents with
owners, a customer email to an agent's own address, a handoff that runs across
two agents in one thread, approvals waiting on a person, an audit trail, and a
briefing an agent wrote. The people and the company are invented and say so in
their domain (`northwind.example`). The product is not invented: every row goes
into the schema the running admin reads, so a screenshot cannot drift from what
Nessie does without this run breaking first.

[`snapshot.sql`](snapshot.sql) is that database, dumped. The fixture can only
rebuild the scenes against the schema it was written for, so the dump is the
other half: the exact rows behind the current pictures, restorable later
without re-deriving anything.

```bash
# Save the database you just shot
DATABASE_URL=… pnpm --filter @nessie/admin shots:save

# Bring it back on a clean database and re-shoot from it
DATABASE_URL=… pnpm --filter @nessie/api exec prisma migrate deploy
DATABASE_URL=… pnpm --filter @nessie/admin shots:restore
DATABASE_URL=… SHOTS_SKIP_SEED=1 pnpm --filter @nessie/admin shots
```

Restoring truncates first: `prisma migrate deploy` writes the bootstrap
organisation itself, so a plain load collides on `organizations_pkey`.
`SHOTS_SKIP_SEED=1` then leaves the restored rows exactly as they are instead
of re-deriving them against today's schema.

Postgres client tools are not on every machine's PATH and a mismatched
`pg_dump` refuses to talk to a newer server, so set `SHOTS_PG_CONTAINER` to the
container running the database and both commands go through it.

## When a shot breaks

A failure names the selector that stopped matching. That is the point: a UI
change that moves a surface out from under the website's pictures now fails
loudly here, instead of leaving the homepage quietly describing a screen that
no longer exists.

## What is not captured

`control-sso` — "Sign in through your own SSO". A local fixture has no identity
provider, so the sign-in screen reads *"No sign-in providers are configured"*,
which is the one thing that row must not show. It needs a run against a
UOA-configured instance, or copy that matches a screen this fixture can make.
Until then the row borrows `control-host.png`.
