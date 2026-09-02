# Settings at three scopes, with overrides

**Date:** 2026-09-03 · **Status:** proposal

Settings live at three scopes — **organisation → team → user** — and the same
setting can be set at any of them. The nearest scope to the person wins,
unless a scope above it locked the setting.

## 1. Why a framework rather than more columns

Cascading resolution is not new here — it is bespoke four times over, and no
two agree:

- **Budgets** already resolve most-specific-first (team → project → org), with
  `mode: 'off'` meaning "inherit" and `unlimited` an explicit override that
  *stops* inheritance (`packages/runtime/src/budget.ts`). This is the closest
  existing thing to the rule below, and the shape to be consistent with.
- **Policy rules** run a seven-level scope chain evaluated deny-first
  (`packages/workspace-admin/src/policy-check.ts`), so an organisation `deny`
  cannot be overridden by a narrower `allow` — a lock in all but name.
- `Team.callProvider` is a bare per-team column with no organisation default
  and no lock, edited through a per-team selector on the *organisation* page.
- The Browserbase connection resolves **organisation first, personal second** —
  the opposite precedence — with the ordering hardcoded so an owner cannot
  choose it.

So the framework is not a new idea; it is the one the codebase keeps
re-deriving. What genuinely does not exist anywhere is a **per-setting lock**
(an ancestor forbidding a descendant from changing a value) and any generic
settings store. Settings themselves cascade nowhere: every flag in §3 lives at
exactly one scope.

**Scope note.** Structurally the hierarchy is Organisation → Project → Team; a
`Team` hangs off a `Project`, and budgets cascade through all three. This plan
deliberately exposes only **organisation → team → user**, because that is the
hierarchy people actually work in (a UOA workspace *is* a team) and a project
tier nobody asked for is a level to explain in every UI. Resolution walks past
projects rather than through them; adding a project tier later is a scope value
and a resolver step, not a redesign.

## 2. The rule

Effective value = walk `organisation → team → user`, taking the last value
set, and **stop descending at the first scope that locked the key**.

- An organisation that locks a key pins it for every team and person.
- An organisation that leaves it open lets a team set it; a team that locks it
  pins it for its members; a team that leaves it open lets a person set it.
- A scope that has no row for a key is transparent — it neither sets nor locks.

The lock is what turns today's hardcoded Browserbase precedence into policy:
"everyone uses the company account" becomes an organisation lock rather than a
rule baked into the resolver, and "use your own if you have one" becomes the
absence of that lock. Same protection, chosen rather than assumed.

## 3. Storage

```
ScopedSetting
  organizationId        tenancy on every row, always
  scope                 organization | team | user
  scopeId               the organisation, team, or user id
  key                   'calls.provider', 'browser.connection', …
  value                 Json
  locked                boolean — levels below cannot override
  updatedByUserId
  @@unique([scope, scopeId, key])
```

A generic store, not typed columns, because the whole point is that a new
setting costs a key rather than three migrations and a resolver. Tenancy is a
composite FK per scope, the `Agent.ownerUserId` precedent, so one tenant's row
can never be read into another's cascade.

**Migration, not coexistence.** `Team.callProvider` moves onto
`calls.provider` and the column is dropped; the Browserbase connection's
org-vs-personal resolution moves onto `browser.connection`. Leaving either in
place would give two answers to "what is this team's call provider", which is
the drift this exists to end.

## 4. Surfaces

Three pages, one structure — **Profile** (who this is) and **Agents** (what
its agents can do):

| | Profile | Agents |
|---|---|---|
| **User** | photo, name, session | browser |
| **Team** | icon, name | browser |
| **Organisation** | logo, workspace avatar | calls, browser |

The user page additionally carries **Notifications**, **Appearance** and
**Security** as tabs; those leave the sidebar's Account group, which is
otherwise a menu of single-panel pages.

Every cascading control renders the same three states, because a person
looking at a setting must be able to tell which of these they are in:

1. **Set here** — this scope owns the value; a lock control sits beside it.
2. **Inherited from <scope>** — shown with its value and where it came from,
   with a control to override.
3. **Locked by <scope>** — shown with its value, no control, and the scope
   that pinned it named. A disabled control with no explanation is the thing
   that makes people file bugs.

## 5. Open questions

1. **Which keys cascade first.** `browser.connection` and `calls.provider` are
   the two with real demand. `conversationalSetupEnabled` is being removed
   (always on), not cascaded — see the consequence below.
4. **Always-on conversational setup is a widening, not just a deleted toggle.**
   The flag currently gates three things: `app_search` and
   `app_connect_request` are stripped from a run's tools when it is false
   (`run-setup.ts`), the app-connection-request presenter returns null, and two
   PA-tool paths throw. Defaulting it true gives every organisation those two
   tools. The remaining guards — active membership, PA-DM channel identity,
   system-managed PA binding — still apply, and installing an app still needs
   a person's explicit consent, so the widening is "agents may offer to set an
   app up" rather than "agents may install one".
2. **Team settings authorship.** Who may edit a team's settings — any member,
   or the org owner? Today no team-scoped settings page exists at all, and the
   one team setting that exists (`callProvider`) is written by an owner-or-admin
   route (`PATCH /api/teams/:teamId/settings`).
3. **The rest of the Account group.** Connected accounts, Secrets,
   Integrations and Statuses stay in the sidebar for now; folding them in is a
   second pass once the tab pattern is real.
