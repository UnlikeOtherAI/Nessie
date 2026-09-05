# Organisation custom theme

**Date:** 2026-09-05 · **Status:** design, ready to build

An organisation administrator authors a **colour scheme** in the business's
colours. It appears beside the ten built-in themes as one more card, labelled
with the organisation's name, and it is what everyone in the organisation sees
until they choose something else. **It is colours and nothing else** — no type,
no radii, no spacing, no motion, no imagery, no shadows. The user's words:
"it literally just needs to be the color scheme; everything else would be too
complex to manage." Every contract below is shaped so that nothing but colour
can be authored, stored, or sent.

Home: a new **Appearance** tab on `/settings/organization`. Doorway: the
per-user Colours panel, where the card is picked. Both are named in §7.

## 1. The model — four seeds, forty-eight tokens

### 1.1 What an admin authors

```
{
  appearance: 'light' | 'dark',
  accent:     '#rrggbb',          // the brand's primary colour
  surface:    '#rrggbb',          // the background pages sit on
  sidebar:    '#rrggbb' | null    // the navigation column; null = derived
}
```

Four inputs; everything else is derived. Not a token-by-token editor, and not a
single accent swap.

**Why not every token.** A built-in theme is 48 colour tokens
(`admin/src/styles.css`, each `[data-theme]` block redeclares exactly the set
listed in §1.3). An admin asked for 48 hex values will not finish, and the
result of one who does is a palette in which `--accent-soft` does not match
`--accent`, `--tx3` fails contrast on `--panel`, and `--sep` disappears into
`--main`. Coherence between tokens is the whole craft of the built-ins, and it
is exactly what a formula can guarantee and a form cannot.

**Why not only an accent.** Recolouring `--accent` on top of Sandstone leaves
warm sand surfaces under a corporate blue. That is not "in the colours of the
business"; the built-ins themselves carry their hue in the rail and sidebar
(`nebula`'s rail is purple, `forest`'s is green, `sunset`'s is brown), and a
brand theme that cannot do the same is visibly not one of them.

**Why these four.** A brand is a primary colour plus a preference for light or
dark; the background is where that preference is stated in a colour, and the
sidebar is the one surface the built-ins tint, so it is the one surface a
brand may want to own outright (the aubergine-sidebar look). Text, borders,
hover states, soft fills, links and status colours are consequences, and
deriving them is what lets §8's contrast floors hold by construction.

**Why the sidebar is optional.** Every built-in derives its rail and sidebar
from the accent's hue at low chroma over the surface's lightness; §1.4 does
the same, so the derived result is a sibling of `nebula`/`midnight`/`ocean`.
The seed is there for the brand that wants a stronger tint than that rule
gives.

**What is deliberately not a seed.** Text colour (derived to hit contrast),
link colour (derived from the accent, adjusted to 4.5:1), the status family —
danger, warning, success, info — which stays fixed per appearance because red
must remain red whatever the brand, and overlays/scrims, which are alphas over
fixed ink. `--thinking` and `--executing` are derived (§1.4). Nothing outside
the 48 colour tokens is touched: `--font-*`, `--radius-*`, `--page-gutter`,
`--duration-*`, `--aura-wash` are `:root`-only in `styles.css` and stay so.

### 1.2 Where the derivation lives

`packages/schemas/src/organization-theme.ts` (plus a sibling
`packages/schemas/src/colour.ts` for the colour maths), exported from
`@nessie/schemas`. Both the admin and the API already depend on that package,
and the precedent is exact: `secret-precedence.ts` lives there "because both
ends need the identical answer" (`packages/schemas/src/secret-precedence.ts`
header). The API runs the evaluation to refuse a palette that fails a floor;
the admin runs the same function for the live preview, the checks list, the
theme card's swatch and the injected CSS. Two derivations would be two themes.

No colour library. The maths is ~120 lines (§1.4 gives every formula) and the
only dependency `@nessie/schemas` carries is `zod`; that stays true.

Exports:

```ts
export const HexColourSchema = z.string().regex(/^#[0-9a-f]{6}$/)
export const OrganizationThemeSchema = z.object({
  appearance: z.enum(['light', 'dark']),
  accent: HexColourSchema,
  surface: HexColourSchema,
  sidebar: HexColourSchema.nullable(),
}).strict()
export type OrganizationTheme = z.infer<typeof OrganizationThemeSchema>

/** The 48 names every [data-theme] block in admin/src/styles.css redeclares. */
export const THEME_TOKENS = [ /* §1.3 */ ] as const
export type ThemeTokens = Record<(typeof THEME_TOKENS)[number], string>

export type ThemeCheck = {
  id: 'surface-band' | 'surface-chroma' | 'sidebar-band'
    | 'accent-on-main' | 'accent-on-panel'            // blocking
    | 'accent-on-sidebar' | 'accent-near-danger'      // warning
  level: 'blocking' | 'warning'
  label: string      // "Accent on background"
  ratio?: number     // contrast, one decimal, where the check is a contrast
  floor?: number
  message: string    // the sentence the screen shows (§7.5 lists them)
}

export type EvaluatedTheme = {
  colorScheme: 'light' | 'dark'
  tokens: ThemeTokens
  checks: ThemeCheck[]
  valid: boolean     // no blocking check present
}

export const evaluateOrganizationTheme = (theme: OrganizationTheme): EvaluatedTheme
/** `[data-theme="organization"]{color-scheme:dark;--rail:#…;…}` — one rule, no whitespace. */
export const organizationThemeCss = (evaluated: EvaluatedTheme): string
export const contrastRatio = (a: string, b: string): number   // WCAG 2.x
```

`HexColourSchema` is lowercase six-digit only. The form normalises (`#ABC` →
`#aabbcc`) before sending; the API does not accept variants, so there is one
spelling in the database and string equality is colour equality.

### 1.3 The token set

`THEME_TOKENS`, in the order the `[data-theme]` blocks declare them:

```
rail sb sb-active ink muted line main main-hover sep border-strong
tx tx2 tx3 lnk accent accent-soft danger warning thinking executing
panel panel-soft accent-hover accent-strong on-accent
surface-inverse surface-inverse-2
success success-soft success-border success-text
danger-soft danger-border danger-text danger-strong
warning-soft warning-border warning-text
info info-soft info-border info-text
overlay-weak overlay overlay-strong scrim-weak scrim scrim-strong
```

plus `color-scheme`, which is not a custom property but every block sets it.

A test in `admin/test/organization-theme-tokens.test.ts` reads `styles.css`,
extracts the `--*` names from the `[data-theme="midnight"]` block, and asserts
they equal `THEME_TOKENS` as a set. That pins the design-system rule "adding a
theme = redeclare every token" onto the runtime theme: a token added to the
built-ins without a derivation rule fails CI rather than rendering as
`initial-value: #000000` from the `@property` registrations at the top of
`styles.css`.

### 1.4 The derivation

**Colour space.** OKLCH for every lightness/chroma operation — perceptually
uniform, so "−0.06 L for hover" reads the same on a navy and on an orange.
WCAG 2.x relative luminance for every contrast ratio — it is what audits
measure. Both from Björn Ottosson's published OKLab matrices; write them into
`colour.ts` verbatim:

```
sRGB → linear:   c ≤ 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4
linear → sRGB:   c ≤ 0.0031308 ? 12.92 c : 1.055 c ^ (1 / 2.4) − 0.055

linear RGB → OKLab:
  l = 0.4122214708 r + 0.5363325363 g + 0.0514459929 b
  m = 0.2119034982 r + 0.6806995451 g + 0.1073969566 b
  s = 0.0883024619 r + 0.2817188376 g + 0.6299787005 b
  l' = cbrt(l)  m' = cbrt(m)  s' = cbrt(s)
  L = 0.2104542553 l' + 0.7936177850 m' − 0.0040720468 s'
  a = 1.9779984951 l' − 2.4285922050 m' + 0.4505937099 s'
  b = 0.0259040371 l' + 0.7827717662 m' − 0.8086757660 s'
  C = sqrt(a² + b²)   h = atan2(b, a) in degrees, normalised to [0, 360)

OKLab → linear RGB:
  l' = L + 0.3963377774 a + 0.2158037573 b
  m' = L − 0.1055613458 a − 0.0638541728 b
  s' = L − 0.0894841775 a − 1.2914855480 b
  l = l'³  m = m'³  s = s'³
  r = +4.0767416621 l − 3.3077115913 m + 0.2309699292 s
  g = −1.2684380046 l + 2.6097574011 m − 0.3413193965 s
  b = −0.0041960863 l − 0.7034186147 m + 1.7076147010 s

Gamut: if any channel falls outside [0, 1], reduce C by 0.005 (keep L, h)
and retry; after that, clamp. Lightness and hue are never sacrificed.

Relative luminance Y = 0.2126 R + 0.7152 G + 0.0722 B  (linear channels)
Contrast(a, b) = (Y_lighter + 0.05) / (Y_darker + 0.05)
```

Helpers used below: `set(L, C, h)` → hex through the gamut rule;
`alpha(hex, a)` → `rgba(r, g, b, a)`; `solve(startL, dir, targets, floor, C, h)`
→ starting at `startL`, step L by `dir · 0.02` (dark themes step up, light
themes step down) until `min(contrast(candidate, t) for t in targets) ≥ floor`,
at most 40 steps, then return the candidate. `S`, `A`, `SB` are the OKLCH
forms of surface, accent and the (given or derived) sidebar; `dark` is
`appearance === 'dark'`. `clampC(x) = min(0.05, max(0.012, x))` keeps a
near-neutral from collapsing to pure grey.

**The tint hue `H`.** Every grey in the palette — rail, borders, text, ink,
inverse surfaces — leans toward one hue, as the built-ins' do (`daylight`'s
greys are cool because its accent is blue; `sandstone`'s are warm). That hue
is the seeded sidebar's when one is given and it is actually chromatic, and
the accent's otherwise:

```
H = (sidebar given && SB.C ≥ 0.01) ? SB.h : A.h
```

The chroma guard matters: a derived light sidebar clamps to white, whose hue
is arithmetic noise (`#ffffff` reports h = 90°), and a rail derived from it
came out yellow for a blue brand in the check that produced these formulas.

**Validation runs first** (§8.1). Derivation assumes it passed.

**Sidebar and rail.**

```
SB (given)     = oklch(sidebar)
SB (derived)   dark:  set(S.L − 0.02, min(0.04, max(A.C · 0.4, 0.015)), A.h)
               light: set(min(1, S.L + 0.02), min(0.01, S.C), A.h)
rail           dark:  set(SB.L + 0.04, min(0.10, SB.C · 1.6 + 0.01), H)
               light: set(SB.L − 0.04, min(0.04, SB.C · 1.6 + 0.01), H)
sb             = SB
sb-active      dark: accent-hover     light: accent
```

The rail sits one step from the sidebar toward mid-grey and a touch more
saturated, which is how every built-in pair is constructed (`nebula` rail
`#2e1132` over sidebar `#1e1222`; `daylight` rail `#eef2f7` under sidebar
`#ffffff`). `--sb-active` is consumed only through `color-mix(… 20%/10%,
transparent)` (`styles.css` ~1835), a tint with no text on it, so it needs no
contrast rule.

**Surfaces.**

```
main               = surface
main-hover         dark: set(S.L + 0.04, S.C, S.h)   light: set(S.L − 0.04, S.C, S.h)
panel              dark: set(S.L + 0.04, S.C, S.h)   light: set(min(1, S.L + 0.02), S.C · 0.5, S.h)
sep                dark: set(S.L + 0.07, S.C, S.h)   light: set(S.L − 0.10, min(0.05, S.C · 1.5 + 0.005), S.h)
border-strong      dark: set(S.L + 0.18, clampC(SB.C), H)
                   light: set(S.L − 0.20, clampC(SB.C), H)
surface-inverse    dark: set(0.98, 0.01, H)          light: panel
surface-inverse-2  dark: set(0.95, 0.015, H)         light: rail
line               dark: alpha(tx2, 0.16)            light: alpha(tx, 0.14)
```

**Text.** Hue is `H` so the greys agree with the chrome; chroma is tiny.
Every text token is *solved* for contrast rather than fixed, so the floors in
§8 are true for any seed that passed validation.

```
targets T = [main, panel, sb, rail]
dark:
  tx     = solve(0.92, +1, [main, panel], 7.0, 0.005, H)
  tx2    = solve(0.83, +1, T, 4.5, 0.010, H)
  tx3    = solve(0.66, +1, T, 4.5, 0.015, H)
  muted  = solve(0.56, +1, [main], 3.0, 0.030, H)
  ink    = set(0.24, min(0.04, max(0.012, SB.C)), H)
light:
  tx     = solve(0.23, −1, [main, panel], 7.0, min(0.02, SB.C), H)
  tx2    = solve(0.40, −1, T, 4.5, 0.020, H)
  tx3    = solve(0.53, −1, T, 4.5, 0.020, H)
  muted  = solve(0.55, −1, [main], 3.0, 0.030, H)
  ink    = tx
```

`--ink` is always dark: it is the text on `--surface-inverse`, which is always
light (`styles.css` `.glass-panel input { color: var(--ink) }`; the workflow
designer's chips). `--muted` is decorative secondary text in the workflow
designer only, hence the 3:1 floor.

**Accent family.** The accent itself is used verbatim — it is the brand's
colour and §8 refuses rather than adjusts it.

```
accent         = accent (as given)
on-accent      = contrast(accent, '#ffffff') ≥ 4.5 ? '#ffffff' : '#000000'
accent-hover   A.L ≥ 0.40 ? set(A.L − 0.06, A.C, A.h) : set(A.L + 0.06, A.C, A.h)
accent-strong  A.L ≥ 0.40 ? set(A.L − 0.12, A.C, A.h) : set(A.L + 0.12, A.C, A.h)
accent-soft    = alpha(accent, dark ? 0.16 : 0.12)
panel-soft     = alpha(accent, 0.08)
lnk            = solve(A.L, dark ? +1 : −1, [main, panel], 4.5, A.C, A.h)   // = accent when it already passes
thinking       dark: set(0.80, min(A.C, 0.12), A.h)   light: accent-strong
executing      = success
```

`on-accent` is never a failure: for any colour, white-contrast × black-contrast
= 1.05 / 0.05 = 21 exactly, so whichever the rule picks is ≥ 4.5:1 (white at
4.4 implies black at 4.77). Pure black, not a near-black: `#0a0a0a` shaves
the product to 19.8 and lets a 4.45 white pair with a 4.45 black. White is
preferred because that is what brands put on their primary; `#000000` is the
built-in `contrast` theme's answer for a bright accent.

**Status family — fixed per appearance**, copied from `midnight` (dark) and
`daylight` (light) in `styles.css`:

```
dark:  danger #ef4444  danger-soft rgba(239,68,68,0.12)  danger-border rgba(239,68,68,0.35)
       danger-text #fca5a5  danger-strong #dc2626
       warning #f59e0b  warning-soft rgba(245,158,11,0.15)  warning-border rgba(245,158,11,0.35)
       warning-text #fde68a
       success #22c55e  success-soft rgba(34,197,94,0.15)  success-border rgba(34,197,94,0.45)
       success-text #86efac
       info #38bdf8  info-soft rgba(56,189,248,0.15)  info-border rgba(56,189,248,0.4)
       info-text #7dd3fc
light: danger #dc2626  danger-soft rgba(220,38,38,0.1)  danger-border rgba(220,38,38,0.32)
       danger-text #b91c1c  danger-strong #b91c1c
       warning #d97706  warning-soft rgba(217,119,6,0.14)  warning-border rgba(217,119,6,0.34)
       warning-text #92400e
       success #16a34a  success-soft rgba(22,163,74,0.12)  success-border rgba(22,163,74,0.35)
       success-text #166534
       info #0284c7  info-soft rgba(2,132,199,0.12)  info-border rgba(2,132,199,0.35)
       info-text #0369a1
```

**Overlays and scrims.**

```
dark:  overlay-weak rgba(255,255,255,0.06)  overlay rgba(255,255,255,0.1)  overlay-strong rgba(255,255,255,0.2)
       scrim-weak rgba(0,0,0,0.1)  scrim rgba(0,0,0,0.2)  scrim-strong rgba(0,0,0,0.5)
light: overlay-weak alpha(tx,0.05)  overlay alpha(tx,0.08)  overlay-strong alpha(tx,0.14)
       scrim-weak alpha(tx,0.08)  scrim alpha(tx,0.18)  scrim-strong alpha(tx,0.45)
```

(`daylight` and `sandstone` scrim with their own ink — `rgba(15,23,42,…)`,
`rgba(43,32,24,…)` — which is what `alpha(tx, …)` reproduces.)

The derivation is deterministic and unversioned. Tuning a rule later reshapes
every organisation's theme the way retuning `nebula` reshapes every screen
using it — that is a feature, and pinning would be a second theme format.

## 2. Light or dark — one variant, stated

An organisation theme is **one palette with one declared appearance**, exactly
like each built-in (`color-scheme` is set per block in `styles.css`). Reasons:

- It keeps the org theme the same *kind of thing* as the built-ins: one card,
  one `data-theme` value, one `color-scheme`. `system` keeps meaning "follow
  the OS between `nebula` and `daylight`" (`getSystemTheme` in
  `admin/src/providers/ThemeProvider.tsx`), untouched.
- A brand palette is authored once. Deriving a dark twin from a light brand,
  or the reverse, invents a palette nobody at the business approved and puts
  it on every screen under their name.
- Two palettes is two forms, two validations and two previews for a first
  change whose stated goal is "colours, nothing more complex."

`appearance` is an explicit seed rather than inferred from the background,
because it is the admin's first decision and it constrains the other three
(§8.1's bands). A redundant control that could disagree with the colour would
be a validation problem; an explicit one is the thing that makes the bands
explainable.

## 3. Storage and contract

### 3.1 The palette is organisation content: a column

`Organization.theme Json?` (`@map("theme")`), beside `logoAttachmentId` and
`stripImageMetadata` in `api/prisma/schema.prisma` — the same kind of thing as
the logo: content the organisation owns, that every member must read and only
an administrator may write. The stored value is the `OrganizationTheme` seed
object, never derived tokens.

Migration `api/prisma/migrations/<stamp>_organization_theme/migration.sql`,
stamped to sort after the latest (`20260906140000_…`):

```sql
ALTER TABLE organizations ADD COLUMN theme jsonb;
-- §5.2: make "never chose a theme" structural again.
UPDATE users SET preferences = preferences - 'theme'
 WHERE preferences->>'theme' = 'sandstone';
```

(Table names as mapped in `schema.prisma`; migrations are immutable once
merged — `docs/standards/build-and-release.md`.)

**Why not a `ScopedSetting` row.** Two reasons, both structural. First,
`GET /api/settings/scoped?scope=organization` is owner-or-admin only
(`authorizeScope` in `api/src/routes/scoped-settings.ts`), and every member
must read the palette to render it — so a settings row would need a second,
member-readable endpoint anyway, whereas `GET /api/organizations/current`
already answers every member and gains one field. Second, the palette is not
a setting that exists at more than one level: there is no team palette and no
personal palette, so the cascade has nothing to resolve. (§5.4 says where a
lock would go if one were ever wanted.)

### 3.2 The choice stays on the account

`User.preferences.theme` gains one value: `'organization'`.
`UserPreferencesSchema.theme` in `packages/schemas/src/identity.ts` is the
enum to extend; `PATCH /api/auth/me/preferences` (`api/src/routes/auth-core.ts`)
needs no change — it merges keys.

**Reconciling this with the scoped-settings standard, honestly.** The standard
says a setting that exists at more than one level goes through `ScopedSetting`.
The personal theme choice is *account-level and cross-tenant*: it rides in
`me.user.preferences` and follows the person into every organisation they
belong to, like their display name. `ScopedSetting` rows carry `organizationId`
on every row ("tenancy on every row, always" — `docs/plans/2026-09-03-scoped-settings.md`
§3), so moving the choice there would either copy it per organisation or make a
person's theme flip when they switch team. Neither is the behaviour anyone
wants. That mismatch, not convenience, is why the person level keeps its store.

And with no lock (§5.4) the organisation level is not a *setting* at all — it is
the fallback for the undecided, in the same sense that `sandstone` is today
without being a level. If a lock is ever wanted, the standard's own pattern
applies unchanged: a `ScopedSetting` organisation row on key
`appearance.theme` carrying `locked` and no value ("a lock may carry no value"),
enforced in the preferences PATCH and surfaced through `ScopedSettingGate` on
the Colours panel. Nothing in this change makes that harder.

### 3.3 Wire shape

`OrganizationSummarySchema` (`packages/schemas/src/identity.ts`) gains

```ts
theme: OrganizationThemeSchema.nullable(),
```

`UpdateOrganizationRequestSchema` gains

```ts
theme: OrganizationThemeSchema.nullable().optional(),   // null clears
```

and its `refine` accepts a body that carries only `theme`.

`PATCH /api/organizations/current` (`api/src/routes/organizations.ts`), already
gated by `resolveOrganizationAdministrationAccess`, adds:

```ts
if (body.theme) {
  const evaluated = evaluateOrganizationTheme(body.theme)
  if (!evaluated.valid) {
    const blocking = evaluated.checks.find((check) => check.level === 'blocking')!
    sendApiError(reply, 400, 'INVALID_THEME', blocking.message, 'theme', evaluated.checks)
    return reply
  }
}
…
...(body.theme !== undefined ? { theme: body.theme ?? Prisma.DbNull } : {}),
```

and both responses include `theme: organization.theme ?? null`. The API stores
seeds and never tokens; the client derives. The API still evaluates, because a
palette that fails a floor must not exist in the database whatever client sent
it.

Admin facade (`admin/src/facades/organization/hooks.ts`):
`useUpdateOrganizationTheme()` → `patch('/api/organizations/current', { theme })`,
invalidating `organizationKeys.current` on success — the same shape as
`useUpdateOrganizationLogo`. `useCurrentOrganization` gains
`enabled: sessionState === 'authenticated'` (from `useAuthSession`), because
`ThemeProvider` will now observe it and must not fire it on the sign-in screen.

## 4. How it reaches the pixel

### 4.1 One runtime-filled `[data-theme="organization"]` block

`ThemeProvider` owns a single `<style id="nessie-organization-theme">` in
`<head>` whose text is `organizationThemeCss(evaluated)`:

```css
[data-theme="organization"]{color-scheme:dark;--rail:#0b1416;--sb:#0d1a1d;…}
```

Switching remains one attribute write —
`document.documentElement.dataset.theme = 'organization'` — identical to
switching to `forest`. This is chosen over inline custom properties on
`documentElement` because a rule keyed on `data-theme` is inert the moment a
person picks a built-in, while inline root properties would beat every
`[data-theme]` block until each one was removed by hand. It also composes with
everything that already keys on `data-theme`: the first-paint script in
`admin/index.html`, focus mode's subtree overrides (`.focus-mode > .admin-shell`
in `styles.css`), the `@property` registrations (which make the swap animate
like any other), and the page-header e2e fixture.

The block is written whenever the organisation summary carries a palette, and
rewritten (or removed) when it changes. While the summary is **loading** and a
first-paint cache (§4.2) exists, the provider leaves both the block and
`data-theme` alone: treating "not yet loaded" as "no palette" would repaint
`sandstone` for one round-trip on every warm load and then repaint back.
`undefined` and `null` are different answers.

### 4.2 First paint

Three `localStorage` keys replace today's one (`nessie.theme`), each with one
meaning:

| key | holds | written by |
|---|---|---|
| `nessie.theme.choice` | the person's **explicit** choice — any `Theme` id, including `organization` and `system` | `setTheme` (a picker click), and mirrored from `me.user.preferences.theme` whenever the account carries one |
| `nessie.theme.applied` | the id last written to `data-theme` (a built-in or `organization`) | the apply effect |
| `nessie.theme.css` | the saved palette's CSS text, verbatim | the apply effect, when the saved palette is applied; removed on sign-out and when the organisation has none |

The inline script in `admin/index.html` becomes:

```
choice = choice key; applied = applied key; css = css key
if choice === 'system'                    → data-theme = matchMedia dark ? 'nebula' : 'daylight'
else if applied === 'organization' && css → append <style id="nessie-organization-theme">css</style>; data-theme = 'organization'
else if applied is a built-in id          → data-theme = applied
else                                      → data-theme = 'sandstone'
```

The css key is a first-paint hint only. `ThemeProvider` replaces it with the
authoritative palette from `GET /api/organizations/current` on every load, and
a *preview* (§7.4) never writes it.

`nessie.theme` (the old key) is removed on provider init. It is not read: its
value was auto-written on every mount (§5.2), so it cannot be trusted as a
choice, and the cost of not reading it is one `sandstone` first paint on the
first load after deploy.

### 4.3 The logged-out screen and the sign-in surface — deliberately not

**The organisation theme does not reach `/login`.** The sign-in screen is
instance state, not tenant state: before sign-in nobody knows which
organisation the visitor belongs to, and under per-UOA-org tenancy an instance
holds many. This is the doctrine `Organization.instanceBrand` was written for
(`api/src/routes/organizations.ts` → `GET /api/brand/logo`;
`docs/deployment/first-deploy.md` → "Branding the sign-in screen": "an org
admin who could set it would be choosing the login screen for every other
tenant"). A palette is not a logo, but it is the same claim on a shared screen.

Concretely: on sign-out `ThemeProvider` removes the style block and the css
key, and `/login` renders from `nessie.theme.choice` if it is a built-in, else
`sandstone`. A choice of `organization` resolves to `sandstone` there, because
there is no organisation. The same browser after the same person signs back in
returns to the palette within one round-trip (the summary refetches after
`queryClient.clear()` in `AuthSessionProvider`).

`packages/sign-in-surface` is untouched: it ships `.signin-*` classes that read
host tokens, and on the admin those are whatever `data-theme` resolves to. The
`nessie.works` landing keeps importing the package's `tokens.css`.

**UOA's hosted sign-in page** (`api/src/services/uoa-auth.ts`
`UOA_SIGN_IN_THEMES`) receives a `SsoTheme`, which stays the ten built-in ids.
`ThemeProvider` exposes `signInTheme: SsoTheme` — the applied built-in, or for
`organization` the built-in of the same appearance (`dark → 'nebula'`,
`light → 'daylight'`, the pair `system` already uses). `LoginPage`,
`TeamSwitcher` and `TeamMembersPage` — the three callers of
`resolveAppliedTheme(theme)` — switch to it, and `resolveAppliedTheme` is
deleted. `SsoThemeSchema` does not change.

Mobile and desktop are not consumers of this change: nothing in `mobile/src`
reads `preferences.theme`, and the Tauri window `theme` is static
configuration (`desktop/src-tauri/src/shell.rs`).

## 5. "Custom default" — the resolution rules

### 5.1 The rule

One pure function, `resolveThemeChoice`, in
`admin/src/providers/theme-resolution.ts` (tested directly):

```
inputs:  serverChoice = me.user.preferences.theme | undefined
         localChoice  = nessie.theme.choice | null
         orgHasTheme  = organization.theme !== null   (false when signed out)
         systemDark   = matchMedia('(prefers-color-scheme: dark)').matches

explicit = signedIn ? (serverChoice ?? localChoice) : localChoice
choice   = explicit ?? (orgHasTheme ? 'organization' : 'sandstone')
applied  = choice === 'system'       ? (systemDark ? 'nebula' : 'daylight')
         : choice === 'organization' ? (orgHasTheme ? 'organization' : 'sandstone')
         : choice
```

In words:

1. **An explicit personal choice always wins** — a built-in, `system`, or
   `organization`.
2. **`organization` is a choice like any other.** It means "my organisation's
   colours, wherever I am": in an organisation with a palette it renders that
   palette; in one without, `sandstone`. The stored value is the fixed id, not
   an organisation id, because the preference is cross-tenant.
3. **A person with no choice gets the organisation's palette when there is
   one, otherwise `sandstone`** — the fallback that exists today
   (`getStoredTheme` in `ThemeProvider.tsx`), with one new step in front of it.
4. **Defining the palette makes it the default.** There is no separate "make
   this the default" switch; saving is the act. Removing it returns the
   undecided to `sandstone`, and people who chose `organization` see
   `sandstone` until it returns or they pick again — their stored choice is
   kept, not rewritten, so a re-added palette comes back to them.
5. **`system` is unchanged.** It follows the OS between `nebula` and
   `daylight`; it does not substitute the organisation palette when the OS
   mode happens to match its appearance. A person who chose System asked for
   their OS's mode, and guessing that they would prefer the brand palette in
   one of the two modes is exactly the kind of quiet override this design
   refuses.

### 5.2 Making "never chose" true again

Today every account has an explicit theme whether or not the person ever
opened the picker. `ThemeProvider.tsx` writes `writeLocalTheme(theme)` in its
apply effect — on first mount that is the `sandstone` default — and the
transfer effect then copies that local value onto the account at first
sign-in (`updatePreferences({ theme: localTheme })`). The result is a database
in which `'sandstone'` means "chose Sandstone" and "never chose" alike, which
would make an organisation palette reach new accounts only, and the admin who
just saved it would see nothing change on their own screen.

Two fixes, both in this change:

- **The transfer copies only `nessie.theme.choice`, and only `setTheme` writes
  that key** (§4.2). A default is never mirrored as a choice again.
- **The migration in §3.1 drops `preferences.theme` where it equals
  `'sandstone'`.** This cannot tell a deliberate Sandstone from a stamped one,
  and it does not need to: `sandstone` remains the fallback, so no screen
  changes on migration day. When an organisation later defines a palette,
  those people see it and can re-choose Sandstone with one click — the
  alternative is a "default" that reaches nobody who has ever signed in.

### 5.3 Where the person sees which state they are in

The Colours panel (§7.6) marks the card carrying the organisation's default
with a `Pill tone="muted"` reading **Default** — the org card when a palette
exists, Sandstone otherwise — so "why am I seeing this" has an answer on the
screen where the question is asked.

### 5.4 No lock, deliberately

An administrator cannot force the palette. A lock on appearance takes away the
person's ability to choose **High Contrast**, or a light or dark theme their
eyes need — the one setting where "everyone uses the company one" is an
accessibility harm rather than a policy. The organisation theme is a default,
never a mandate. If a lock is ever wanted, §3.2 names its exact shape; it is
not built here and the High Contrast card would have to stay selectable under
it.

## 6. Rule zero — home and doorway

- **Home (owning surface):** `/settings/organization?tab=appearance`, a new
  **Appearance** tab on `OrganizationSettingsPage.tsx`, which owns the
  `TabBar` and the `tab` param through `useTabParam`.
  `ORGANIZATION_SETTINGS_TABS` becomes `['profile', 'agents', 'appearance']`,
  in that order — mirroring `USER_SETTINGS_TABS`, where Appearance follows
  Agents. It renders `organization/OrganizationAppearancePage.tsx` under the
  existing `OrganizationAdministrationGate`. Not a top-level route, not a
  `/branding` page, not a home under the per-user Appearance screen.
- **Doorway (member):** the per-user Colours panel
  (`admin/src/pages/settings/appearance/ColoursPanel.tsx`) is where a member
  **sees and picks** the organisation theme among the built-ins — an extra
  card at the top of the grid. That panel is the doorway, not the home: it
  never authors.
- **Doorway (administrator):** on the same Colours panel, when
  `organization.administration.status === 'allowed'`, one line under the grid —
  "Set up a theme in your organisation's colours →" (no palette yet) or
  "Edit your organisation's theme →" — a react-router `Link` to
  `/settings/organization?tab=appearance`. That is the in-context entry point
  on the screen where "can we have our colours?" is asked.

Two surfaces, no fork: the org card in the grid is the same `label` card the
built-ins use, fed by the provider's `themes` list (§7.6).

## 7. The authoring UI

### 7.1 Frame

`OrganizationAppearancePage` renders
`<SettingsPanel eyebrow="Organization" title="Appearance" actions={…}>` with the
handed-down `tabs`, then a body at `--page-gutter` (that is what `SettingsPanel`
already does), full width.

Header actions (`PageHeaderAction[]`, roles per `docs/standards/design-system.md`):

- **Save theme** — `primary: true`. The commit is the one thing this screen
  exists for. Disabled while the draft is invalid, while saving, or while
  nothing has changed and a palette already exists. Label `Saving…` while
  pending.
- **Remove theme** — secondary, `tone: 'danger'`, present only when a palette
  is saved. Opens `ConfirmDialog` (`destructive`, title "Remove the
  organisation theme?", body "Everyone who hasn't chosen a theme goes back to
  Sandstone. People who chose {org name} will see Sandstone until a theme is
  saved again.", confirm "Remove theme").

One primary per header. No Refresh, no Close.

### 7.2 Layout

Body is `grid gap-4 lg:grid-cols-2`. Left: one `Card as="section"` holding the
form. Right: a section — **not** a card, because its content is a framed
preview and a bordered box never sits inside a bordered box — holding the
checks list. On narrow screens they stack. No sub-tabs: this page is already a
tab of the organisation screen.

### 7.3 The form (left card)

```
SectionLabel        Theme
intro (tx2, sm)     Your organisation's own colours, offered to everyone in
                    {org name} as a theme and used by default for anyone who
                    hasn't chosen one. People can still pick any theme,
                    including High Contrast.

FormField  Appearance
  TabBar role="radiogroup"   [ Light | Dark ]      (collapse="never"; two short words)
  help: Whether text is dark on light, or light on dark. The background and
        sidebar must match this.

FormField  Accent
  ColourField
  help: Buttons, links, selection and the active item. Your brand's primary colour.

FormField  Background
  ColourField
  help: The colour pages sit on. Keep it near-white for a light theme or
        near-black for a dark one — strong colour here makes text hard to read.

FormField  Sidebar
  checkbox  "Derive from the accent"   (default on)
  ColourField  (disabled and showing the derived value while the box is on)
  help: The navigation column. Derived from your accent unless you set it.

FormError / FormSuccess line
  success after save:   Theme saved. It's now the default for everyone in
                        {org name} who hasn't chosen one.
  success after remove: Theme removed.
  error:                the API message, or "Could not save the theme."

small text link, right-aligned, shown only while dirty:  Reset to saved
  (restores the saved seeds, or the starting palette when none is saved)
```

`ColourField` is a new shared control at
`admin/src/components/shared/ColourField.tsx`: a native `<input type="color">`
(the 30px compact box, sized with `admin-input-compact`, no third-party picker)
beside a mono `Input` (`admin-input-mono`, capped with an inner `max-w-[9rem]`
— the cap is on the control, never the page). Both are bound to one string;
typing normalises to lowercase `#rrggbb` on blur and accepts `#abc`; anything
else shows the field error "Enter a colour like #1a73e8" through `FormField`'s
`error`. It carries no colour of its own beyond the value it displays.

**Starting palette** (no saved theme): `{ appearance: 'light', accent:
'#2563eb', surface: '#f8fafc', sidebar: null }` — `daylight`'s values, the most
neutral place to start — with a `Notice tone="neutral"` above the fields:
"No theme yet. Start from the colours below and replace the accent with your
brand colour." Save is enabled as soon as the draft is valid (the starting
palette is valid), so an organisation that wants Daylight-as-ours can save
without editing.

**Loading:** the card renders `SectionLabel` Theme + "Loading…", as
`LogoPanel` does. **Permission:** `OrganizationAdministrationGate` already
wraps every organisation tab; the page adds no second check.

### 7.4 Live preview — the app is the preview

There is no miniature. While this page is mounted and the draft is **valid**,
`ThemeProvider.setPreview(evaluated)` writes the draft's CSS into the one style
block and sets `data-theme="organization"`, so the admin sees the real sidebar,
the real header, the real cards and every real status colour change under
their hands. On unmount, `setPreview(null)` restores the resolved state (§5.1).
Rule zero §4: reuse the surface, never fork it — a mini-shell would be a second
implementation of the shell that drifts from it, and a preview that cannot show
the composer or a dialog is not a preview of Nessie.

While the draft is **invalid**, the preview holds the last valid draft (or the
saved palette, or the admin's own theme when neither exists). The blocking
check is what makes the screen — including the Save button and the checks list
— readable in every draft that is applied, so an admin can never type
themselves into a page they cannot read.

A `Notice tone="info"` sits above the checks list while previewing:
"You're seeing the draft. Your own theme comes back when you leave this page —
choose {org name} under Account → Appearance to keep it."

A preview never writes `nessie.theme.css` and never touches the account's
choice.

### 7.5 Checks (right section)

```
SectionLabel   Checks
<ul>  one row per ThemeCheck the evaluation returned, plus the guaranteed ones:
  [Pill success]  Text on background         12.4:1
  [Pill success]  Secondary text on background  5.1:1
  [Pill success]  Accent on background        4.1:1
  [Pill success]  Button label on accent      5.7:1
  [Pill success]  Link on background          4.5:1
  [Pill warning]  Accent on sidebar           2.4:1   The highlighted item in the navigation will be faint.
  [Pill danger]   Accent on background        2.1:1   Needs at least 3:1. Choose a brighter accent or adjust the background.
```

Ratios come from `contrastRatio` over the derived tokens: tx/main, tx3/main,
accent/main, on-accent/accent, lnk/main; then every `check` in
`evaluated.checks`. A row's pill is `success`, `warning` for `level: 'warning'`,
`danger` for `level: 'blocking'`. Messages are the `message` strings from the
evaluation, so the screen and the API say the same sentence:

| id | message |
|---|---|
| `surface-band` (dark) | For a dark theme the background must be dark — something like #14171c. |
| `surface-band` (light) | For a light theme the background must be light — something like #f8fafc. |
| `surface-chroma` | The background is too colourful for text to sit on. Keep it near neutral and put the colour in the accent or the sidebar. |
| `sidebar-band` | The sidebar must be as dark (or light) as the background — they share the same text colours. |
| `accent-on-main` / `accent-on-panel` | The accent doesn't stand out against the background ({ratio}:1, needs 3:1). Choose a brighter or darker accent, or adjust the background. |
| `accent-on-sidebar` | The highlighted item in the navigation will be faint ({ratio}:1). |
| `accent-near-danger` | Your accent is close to the red used for errors, so destructive buttons will look like ordinary ones. |

Worked examples from the check script that validated §1.4 (kept in the plan so
the first implementation has known-good output to compare against):

| seed | rail / sb / main / panel | tx / tx3 / lnk / on-accent | result |
|---|---|---|---|
| light · `#2563eb` · `#f8fafc` · derived | `#eef2f9` `#ffffff` `#f8fafc` `#ffffff` | `#1d1d1d` `#666c78` `#2563eb` `#ffffff` | valid; tx3/main 5.0, accent/main 4.9 |
| dark · `#0f766e` · `#0b1416` · derived | `#021b19` `#021110` `#0b1416` `#141d1f` | `#e1e6e5` `#899593` `#3a948b` `#ffffff` | valid; lnk lifted to 5.1, accent/main 3.4 |
| dark · `#1f2937` · `#0b1416` · derived | — | — | blocked: accent on background 1.3:1 |
| light · `#611f69` · `#ffffff` · `#f3e8f5` | `#ecd7f0` `#f3e8f5` `#ffffff` `#ffffff` | `#211a23` `#665d67` `#611f69` `#ffffff` | valid; accent/main 11.0 |
| dark · `#e4002b` · `#141414` · derived | `#330507` `#1e0807` `#141414` `#1d1d1d` | `#e8e3e3` `#9b8f8e` `#fe4148` `#ffffff` | valid, warns accent-near-danger (1°) |
| light · `#f59e0b` · `#fffbeb` · derived | — | on-accent `#000000` | blocked: accent on background 2.1:1 |
| dark · `#60a5fa` · `#1e293b` · `#334155` | — | — | blocked: sidebar-band (L 0.37) |
| light · `#2563eb` · `#bfdbfe` · derived | — | — | blocked: surface-chroma (C 0.057) |

### 7.6 The Colours panel (doorway)

`ThemeProvider`'s `themes` list gains, **at index 0 and only when the
organisation carries a palette**, the option
`{ id: 'organization', label: organization.name, description: 'Your
organisation's colours.' }`. `ColoursPanel` renders it with the same `label`
card as the built-ins. `ThemeSwatch` changes from `themeId` to a
`colours: readonly [string, string, string]` prop: the built-ins keep their
static map, the org card passes `[tokens.rail, tokens.accent, tokens.tx]` from
the evaluation. The selected card is the *effective* choice (§5.1's `choice`,
with `organization` falling back to `sandstone` when no palette exists, so a
card is always selected). The **Default** pill from §5.3 sits beside the
swatch. The administrator's link from §6 sits under the grid.

## 8. Accessibility

### 8.1 Blocking — refused by the API, and Save is disabled with the reason on screen

| check | rule |
|---|---|
| `surface-band` | dark: `S.L ≤ 0.35`; light: `S.L ≥ 0.85` |
| `surface-chroma` | `S.C ≤ 0.05` |
| `sidebar-band` (when given) | dark: `SB.L ≤ 0.36`; light: `SB.L ≥ 0.80` |
| `accent-on-main`, `accent-on-panel` | `contrast(accent, main) ≥ 3.0` and `contrast(accent, panel) ≥ 3.0` |

3:1 is WCAG 1.4.11 for non-text UI. Measured, every built-in meets it on
`--main` except `nebula`, whose `#7c3aed` on `#1a1d21` is 2.97:1 — a hair
under, which is one reason the floor is stated here rather than inherited from
the built-ins. The accent is **blocked, not adjusted**: silently shifting the brand's
primary produces a theme that is not the brand's, and a refusal with the ratio
tells the admin exactly what to change. The two bands exist because every text
token is global — the sidebar draws `--tx` on `--sb` — so a light sidebar on a
dark theme (or the reverse) cannot read, whatever the derivation does. The
Slack-style dark-sidebar-light-content look needs sidebar-specific text tokens
and a sweep of the shell; it is out of scope and the message says so plainly.

### 8.2 Guaranteed by construction — never a failure the admin can cause

By §1.4's `solve` and `on-accent` rules, for any seed that passes §8.1:
`--tx` ≥ 7:1 on `--main` and `--panel`; `--tx2`, `--tx3` ≥ 4.5:1 on `--main`,
`--panel`, `--sb` and `--rail`; `--lnk` ≥ 4.5:1 on `--main` and `--panel`;
`--on-accent` ≥ 4.5:1 on `--accent`; `--muted` ≥ 3:1 on `--main`. Status colours
are the audited `midnight`/`daylight` values. `color-scheme` follows
`appearance`, so native controls, scrollbars and form widgets match.

### 8.3 Warned — saved anyway, named on screen

`accent-on-sidebar` below 3:1 and `accent-near-danger` (OKLCH hue within 18°
of the appearance's `--danger` with `A.C ≥ 0.08`). The first no built-in
trips (the lowest is `nebula` at 3.16:1); a strongly tinted seeded sidebar
can. The second is true of `rose` (8° from its red) and `sunset` (13°), and
the threshold is 18° so that `sandstone`'s terracotta, 22° away and plainly
not red, is not flagged. Advice, not a gate.

### 8.4 The person keeps the last word

No lock (§5.4). High Contrast, `system`, and every light or dark built-in stay
one click away on the Colours panel for every member, always.

## 9. Out of scope — do not build

- Per-token overrides, an "advanced" editor, or a JSON import.
- Anything that is not a colour: fonts, font sizes, the per-user Text size
  control (`appearance/TypePanel.tsx` is untouched), radii, spacing,
  `--page-gutter`, motion, shadows, `--aura-wash`, gradients, logos or imagery.
  The seed schema is `.strict()` so a fifth field is a 400.
- A light/dark pair from one theme, or `system` mapping onto the org palette.
- Team-level palettes; an organisation default that is a *built-in* id.
- A lock or any forcing.
- The logged-out sign-in screen, the `nessie.works` landing, UOA's hosted
  sign-in colours, `<meta name="theme-color">`, the Tauri window chrome, the
  mobile app.
- A name or description for the theme (the label is the organisation's name).
- Drafts, publish/unpublish, version pinning, "preview for others".
- Extracting colours from the uploaded logo.
- Moving `User.preferences.theme` into `ScopedSetting`.

## 10. Build notes

Files, with the 500-line cap in mind:

- `packages/schemas/src/colour.ts` — conversions, gamut, luminance, contrast,
  `alpha`. `packages/schemas/src/organization-theme.ts` — schema,
  `THEME_TOKENS`, validation, derivation, `organizationThemeCss`. Export both
  from `packages/schemas/src/index.ts`.
- `packages/schemas/src/__tests__/organization-theme.test.ts` — round-trips
  (`#ffffff` → L 1, `#000000` → L 0, `#7c3aed` → L ≈ 0.54 C ≈ 0.25 h ≈ 293,
  each returning its own hex);
  determinism; every token present for a grid of seeds (six brand accents ×
  light/dark × sidebar given/derived); §8.2 floors hold for every grid entry;
  a failing accent yields `accent-on-main` blocking with a ratio; `surface-band`
  and `sidebar-band` messages; CSS output has no whitespace and 48 declarations
  plus `color-scheme`.
- `admin/test/organization-theme-tokens.test.ts` — `THEME_TOKENS` equals the
  names in `styles.css`'s `midnight` block (§1.3).
- `admin/src/providers/theme-resolution.ts` (pure, tested in
  `admin/test/theme-resolution.test.ts` as a table over §5.1) and
  `admin/src/providers/theme-storage.ts` (the three keys). `ThemeProvider.tsx`
  keeps the context; it should end up near its current size, not double it.
- `admin/src/pages/settings/organization/OrganizationAppearancePage.tsx`,
  `organization/ThemeChecks.tsx`, `admin/src/components/shared/ColourField.tsx`.
- `admin/index.html` inline script per §4.2.
- API: schema, migration, `organizations.ts` PATCH; a route test that a
  non-administrator is refused, an invalid seed is `400 INVALID_THEME` with the
  check list in `details`, `null` clears, and the summary echoes the seed.
- Docs in the same turn: `docs/standards/design-system.md` (the theming bullet
  gains: the `[data-theme="organization"]` block is runtime-filled from
  `@nessie/schemas` `organization-theme.ts`; the three storage keys replace
  `nessie.theme`; the colours-only boundary); `docs/deployment/first-deploy.md`
  → "Branding the sign-in screen" gains one sentence that the organisation
  theme is tenant state and does not reach that screen;
  `docs/plans/2026-06-10-design-system-theming.md` → "To add a theme" notes
  that `THEME_TOKENS` must gain the name and §1.4 a rule.

## 11. Verification — the Playwright pass

Headless, against `http://localhost:5455` with the API on `5454`, using the
`e2e/navigation/lib` helpers (`startApi`, `startAdmin`, `launchBrowser`) in a
new `admin/e2e/organization-theme/run.mjs`, signing in with the local
bootstrap owner. Screenshots to `e2e/screenshots/organization-theme/`:

1. `01-empty.png` — `/settings/organization?tab=appearance` before any save:
   the tab strip showing Profile · Agents · Appearance, the starting palette,
   the "No theme yet" notice, Save enabled, every check green, no Remove.
2. `02-draft-dark.png` — after entering Dark, accent `#0f766e`, background
   `#0b1416`: the **whole page**, proving the live preview repainted the rail,
   sidebar, header and cards. Assert
   `getComputedStyle(document.documentElement).getPropertyValue('--accent')`
   is `#0f766e` and `dataset.theme === 'organization'`.
3. `03-blocked.png` — accent `#1f2937` on that background: Save disabled, the
   `accent-on-background` row red with its ratio, and the page still painted in
   the last valid draft (assert `--accent` is still `#0f766e`).
4. `04-saved.png` — back to `#0f766e`, Save: the success line; reload and
   assert `#nessie-organization-theme` exists in `<head>` and
   `dataset.theme === 'organization'` *before* any network response
   (`page.route` the summary to delay it; the first-paint cache must carry it).
5. `05-colours-panel.png` — `/settings/account?tab=appearance`: the org card
   first, labelled with the organisation's name, selected, carrying
   **Default**, with the administrator link under the grid. Click **Forest**:
   assert `dataset.theme === 'forest'`, the style block still present, and the
   computed `--accent` is Forest's `#047857`. Click the org card: back.
6. `06-login.png` — sign out: `/login` with no style block and
   `dataset.theme === 'sandstone'` (or the built-in the owner chose). Sign back
   in: the palette returns.
7. `07-remove-confirm.png` and `08-removed.png` — Remove theme, the dialog, then
   the account grid without the org card and Sandstone carrying **Default**.
8. Run `pnpm --filter @nessie/admin test:e2e:page-header` unchanged; it proves
   the built-ins did not move.

Plus the unit and route tests in §10 through Turbo with `DATABASE_URL`
exported (`docs/standards/testing.md`).
