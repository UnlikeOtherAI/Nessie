# Settings — one cascade, and a lock a person can see

Authoritative standard, written in the shape [`AGENTS.md`](../../AGENTS.md)
uses for the rest: `AGENTS.md` carries the one-line invariant and points here;
**this file is the rule**.

- **A setting that exists at more than one level goes through the one
  cascade.** `ScopedSetting` (`@nessie/runtime` `scoped-settings.ts`) resolves
  organisation → team → person: the most specific value wins, and the walk
  stops at the first level marked `locked`. Cascading resolution was bespoke
  four times over before this — budgets most-specific-first with `unlimited`
  stopping inheritance, policy rules deny-first over seven scopes,
  `Team.callProvider` a bare column with no organisation default, and the cloud
  browser resolving organisation-first with the ordering hardcoded where no
  owner could see or change it. A fifth hand-rolled ordering is the defect, not
  the pattern.
- **A lock may carry no value.** A row that sets only `locked` pins whatever
  resolved above it. That is how a setting whose value lives in its own table —
  the cloud browser's credential rows — is governed by this cascade instead of
  a second one, and it is why `value` is nullable rather than required.
- **`isLockedAbove` is strictly above.** A level is read-only exactly when a
  level *above* it locked the key, so the locking level still edits its own
  value and a lock never binds upwards. Neutralising the lock fails four of the
  six resolver tests.
- **The lock is visible where it binds.** `ScopedSettingGate` keeps the control
  on screen — hiding it would leave a person wondering where their browser came
  from — greys it, makes the subtree genuinely `inert` through a ref rather
  than `pointer-events-none` alone (which still lets a keyboard user tab into a
  control they cannot operate), and says which level decided. Offering an edit
  the server will refuse is the failure this replaces.
- **The team level must actually reach the person.** A personal surface passes
  the session's team down, or the middle of the cascade is invisible there and
  somebody whose team locked a setting connects an account their team's work
  then never uses. The team id is never taken on the caller's word: an
  unverified one would let any member probe whether an arbitrary team has
  locked a key, so only a team the caller belongs to is used, and anything else
  is dropped rather than refused — the personal answer is still a real answer
  without it. `writeScopedSetting` cannot make that check itself, because a
  person may be in several teams; the route makes it where the team is known.
- **Scopes are the three people work in.** Structurally the tree is
  Organisation → Project → Team, and budgets cascade through all three;
  settings walk *past* projects, not through them. Adding a project tier later
  is a scope value and a resolver step, not a redesign.
- **A cascade with its own storage still states the rule once.** Secrets do not
  live in `ScopedSetting` — a `Secret` row carries a vault reference and grants
  that a settings value has no place for — but they resolve by this same
  sentence, over organisation → team → project → personal, with the same
  `locked` semantics and the same greyed-out-and-say-who treatment below a
  lock. The rule is written once as a pure function in `@nessie/schemas`
  `secret-precedence.ts` and consumed by both the screen and
  `POST /api/secrets`, because the failure this standard exists to prevent is
  two orderings, not two tables. See
  [docs/secret-management-spec.md](../secret-management-spec.md) → "Scope".
- **Authorship mirrors the routes a person's buttons already call.** The
  organisation and its teams are owner-or-admin; a personal setting is the
  person's own. Teams carry no `organization_id` of their own — tenancy runs
  through their project — so the FK cannot prove tenancy and the service must.

Plan, rationale and as-built deltas:
[`docs/plans/2026-09-03-scoped-settings.md`](../plans/2026-09-03-scoped-settings.md).
