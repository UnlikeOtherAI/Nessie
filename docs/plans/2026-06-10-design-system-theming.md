# Design system + color theming

Status: **in progress** (2026-06-10). Goal: make the admin UI fully
theme-able by color alone — a new theme is just a list of color values. Today
`admin/src/styles.css` has a centralized `:root` token palette (~24 CSS custom
properties), but ~half the UI color is hardcoded (raw hex in 27 files, Tailwind
named utilities like `text-white` ×167, `bg-emerald-500`, `bg-black/20`) and
there is no theme-switching layer. This plan adds the missing semantic tokens,
restructures the palette into swappable themes, sweeps the hardcoded colors onto
tokens, and adds a switcher.

Stack: Tailwind **v4** (CSS-based, `@import 'tailwindcss'`, no JS config).
Tokens are plain CSS custom properties consumed as `var(--x)` or
`bg-[var(--x)]`.

## Architecture

- **Single source of truth:** all color lives in `admin/src/styles.css`. The
  base `:root` block defines the default theme ("Nebula"). Each additional theme
  is a `[data-theme="<name>"]` block that re-declares the **same token names**
  with different values. Nothing else in the app may contain a raw color.
- **Switching:** a `ThemeProvider` sets `document.documentElement.dataset.theme`
  and persists the choice to `localStorage` (`nessie.theme`). Default = `nebula`
  (current look) so existing users see no change. An **Appearance** settings
  page lets the user pick.
- **No renames.** Existing token names stay (284 refs to `--tx3` etc.) — renaming
  is churn+risk for no functional gain. We ADD the missing semantic tokens.

## Token taxonomy (final)

Existing (keep as-is, base values unchanged):
`--rail --sb --sb-active --ink --muted --line --main --main-hover --sep`
`--border-strong --tx --tx2 --tx3 --lnk --accent --accent-soft --danger`
`--warning --thinking --executing --panel --panel-soft`

**New tokens to ADD** (base/Nebula values in parentheses):

- Accent depth: `--accent-hover` (`#6d28d9`), `--accent-strong` (`#5b21b6`),
  `--on-accent` (`#ffffff` — text/icons on accent or any colored button).
- Light surface: `--surface-inverse` (`#faf8fc` — light chips/cards/inputs on
  dark), `--surface-inverse-2` (`#f4eff8`).
- Success (green): `--success` (`#22c55e`), `--success-soft`
  (`rgba(34,197,94,0.15)`), `--success-border` (`rgba(34,197,94,0.45)`),
  `--success-text` (`#86efac`).
- Danger (red/rose): `--danger-soft` (`rgba(239,68,68,0.12)`), `--danger-border`
  (`rgba(239,68,68,0.35)`), `--danger-text` (`#fca5a5`), `--danger-strong`
  (`#dc2626`).
- Warning (amber/yellow): `--warning-soft` (`rgba(234,179,8,0.15)`),
  `--warning-border` (`rgba(234,179,8,0.35)`), `--warning-text` (`#fde68a`).
- Info (sky): `--info` (`#1d9bd1`), `--info-soft` (`rgba(14,165,233,0.15)`),
  `--info-border` (`rgba(14,165,233,0.4)`), `--info-text` (`#7dd3fc`).
- Overlays (translucent, theme-tuned): `--overlay-weak`
  (`rgba(255,255,255,0.06)`), `--overlay` (`rgba(255,255,255,0.10)`),
  `--overlay-strong` (`rgba(255,255,255,0.20)`); scrims `--scrim-weak`
  (`rgba(0,0,0,0.10)`), `--scrim` (`rgba(0,0,0,0.20)`), `--scrim-strong`
  (`rgba(0,0,0,0.50)`).

## Mapping table (hardcoded → token)

Raw hex:

| hex | token |
|---|---|
| `#7c3aed` | `--accent` |
| `#6d28d9` `#7445c7` | `--accent-hover` |
| `#5b21b6` `#4f46e5` | `--accent-strong` |
| `#6d3579` | `--sb-active` |
| `#a78bfa` `#d8b4fe` `#ddd6fe` | `--thinking` |
| `#ef4444` | `--danger` |
| `#dc2626` | `--danger-strong` |
| `#f87171` `#fca5a5` | `--danger-text` |
| `#22c55e` | `--success` |
| `#86efac` | `--success-text` |
| `#eab308` | `--warning` |
| `#1d9bd1` | `--lnk` / `--info` |
| `#2e1132` | `--rail` |
| `#1e1222` | `--sb` |
| `#1a1d21` | `--main` |
| `#222629` | `--panel` / `--main-hover` |
| `#2c1832` | `--ink` |
| `#2d2a35` | `--sep` |
| `#3d2e50` | `--border-strong` |
| `#2f2237` `#433349` | nearest of `--panel` / `--border-strong` (judge) |
| `#d1d2d3` | `--tx` |
| `#c0bfc1` | `--tx2` |
| `#8a8b8c` | `--tx3` |
| `#7e6e87` | `--muted` |
| `#8b7a93` `#6f5b77` `#7c6b86` `#9a8aa2` `#5f4e67` `#a7abb0` `#a090b8` `#9b8bab` | `--tx3` / `--muted` (judge by lightness) |
| `#ffffff` `#fff` | `--on-accent` (if text/icon) |
| `#faf8fc` `#fbf9fd` | `--surface-inverse` |
| `#f4eff8` `#f3f4f6` | `--surface-inverse-2` |

Tailwind named utilities (replace `class` with arbitrary `[var(--token)]`,
preserving any `/opacity` only where a soft token doesn't already encode it):

| pattern | token |
|---|---|
| `text-white` (on accent/colored/dark btn) | `text-[var(--on-accent)]` |
| `bg-white/4` `/5` `/6` `/8` | `bg-[var(--overlay-weak)]` |
| `bg-white/10` `/15` `/20` | `bg-[var(--overlay)]` / `--overlay-strong` |
| `bg-white` `bg-white/60` `/80` | `--surface-inverse` (judge) |
| `bg-black/10` | `bg-[var(--scrim-weak)]` |
| `bg-black/20` `/30` | `bg-[var(--scrim)]` |
| `bg-black/50` | `bg-[var(--scrim-strong)]` |
| `border-black/8` `/10` | `border-[var(--line)]` |
| `bg-emerald-500/15` `bg-emerald-400/10` | `bg-[var(--success-soft)]` |
| `bg-emerald-500` `bg-emerald-400` | `bg-[var(--success)]` |
| `text-emerald-*` | `text-[var(--success-text)]` |
| `border-emerald-*` | `border-[var(--success-border)]` |
| `bg-red-500/*` `bg-rose-500/*` | `bg-[var(--danger-soft)]` |
| `bg-red-500` `text-red-*` `text-rose-*` | `--danger` / `text-[var(--danger-text)]` |
| `border-red-*` `border-rose-*` | `border-[var(--danger-border)]` |
| `bg-amber-500/15` | `bg-[var(--warning-soft)]` |
| `text-amber-*` `text-yellow-*` | `text-[var(--warning-text)]` |
| `border-amber-*` | `border-[var(--warning-border)]` |
| `bg-sky-500/*` | `bg-[var(--info-soft)]` |
| `text-sky-*` | `text-[var(--info-text)]` |
| `text-violet-*` | `text-[var(--thinking)]` |
| `text-orange-*` | `text-[var(--warning-text)]` (judge) |

Rule of thumb: **base** color → solid token; **/10–/15 fill** → `*-soft`;
**border** → `*-border`; **text on color** → `*-text`. When a usage is genuinely
ambiguous, leave a `/* TODO theme: <reason> */` and keep the closest token.

## Starter themes (ship 3)

1. **Nebula** (default) — current purple-on-dark. Base `:root`, no change.
2. **Midnight** — neutral slate/blue dark (accent `#2563eb`, surfaces neutral).
3. **Daylight** — light theme (light surfaces, dark text). This is the real test
   that tokenization is complete: if anything is still hardcoded it will glare.

## Work partition (parallel worktrees, one branch each)

- **A — infra** (owns `styles.css`, `providers/ThemeProvider.tsx`, the Appearance
  settings page + its route/nav, `index.html`/root wiring): add new tokens,
  base `:root` + the 3 `[data-theme]` blocks, ThemeProvider + switcher + persist.
  Touches NO feature `.tsx` colors.
- **B — sweep `components/` (non-features)** — shared UI/components (~26 files).
- **C — sweep `components/features/`** — agents, workflow-designer/-tools,
  workflows, channels, knowledge, mcp-app-store, personal-assistant, triggers,
  budgets (~64 files).
- **D — sweep `pages/`** (33) + **`layouts/`** (11).
- **E — sweep `notifications.css` + any remaining `.css` + stragglers** and a
  final repo-wide grep to prove zero raw hex / named-color utilities remain
  outside `styles.css`.

Each sweep agent: reference tokens only, never define them; touch only its
partition; keep `tsc --noEmit` + `eslint --max-warnings 0` + `vite build` green.

## Definition of done

- `grep -rE "#[0-9a-fA-F]{3,6}\b" admin/src --include=*.tsx` → empty (all hex in
  `styles.css` only).
- No Tailwind named-color utilities remain in `admin/src/**.tsx`.
- Switching `data-theme` between nebula/midnight/daylight re-themes the whole UI
  with no orphaned colors (verified with Playwright screenshots of each theme on a
  few representative pages).
- Typecheck + lint + build green; default theme is visually identical to today.

## Implemented (2026-06-10)

Done across 5 parallel worktrees, merged to `main` (held from prod until the
review pass clears). Verified: admin `tsc --noEmit` + `eslint --max-warnings 0`
+ `vite build` all green; audit greps return **0** raw hex in `.tsx`, **0** raw
hex in `.css` outside `styles.css`, **0** Tailwind named-color utilities in
`.tsx`. Playwright screenshots confirm all three themes render: nebula (default,
unchanged), midnight (neutral slate/blue dark), daylight (light content).

- Tokens + theme blocks: `admin/src/styles.css` (`:root` = nebula, plus
  `[data-theme]` blocks for midnight, daylight, forest, ocean, sunset, rose,
  graphite, and sandstone).
- Switcher: `admin/src/providers/ThemeProvider.tsx` (`useTheme()`, persists to
  `localStorage["nessie.theme"]`, sets `document.documentElement.dataset.theme`)
  + `admin/src/pages/settings/AppearancePage.tsx` at `/settings/appearance`.
- Appearance now has two tabs (`AppearancePage.tsx` shell → `appearance/`
  `ColoursPanel` + `LogoPanel`): **Colours** (the theme picker above) and
  **Logo**, where owners/admins upload a round company logo. Selecting a file
  opens `appearance/CircleLogoCropper.tsx` (square stage, masked edges, circular
  crop, pan/zoom → 512×512 circular PNG); the crop uploads via `/api/uploads`
  and is set as the org's `logoAttachmentId` (`facades/organization/hooks.ts`).
  The logo replaces the workspace mark in `SidebarRail` and brands the login
  screen via the public `GET /api/brand/logo`.
- Review pass: remaining component CSS and `.ts` style-helper color escapes are
  tokenized; `admin/index.html` applies the saved theme before first paint;
  dark/light `color-scheme` is set per theme; daylight and sandstone
  `--surface-inverse` values are light so login/bootstrap inputs remain legible.

**To add a theme:** add a `[data-theme="<id>"]` block to `styles.css` that
redeclares **every** token the base `:root` defines, add the id to the `Theme`
union + `THEMES` list in `ThemeProvider.tsx`, and add the matching UOA palette
id to `SsoThemeSchema` / `UOA_SIGN_IN_THEMES`. No component edits — that's the
point.

**Open items for review:** (a) the live in-app switch was not Playwright-verified
(Playwright's synthetic events don't drive a controlled radio; each theme's
*rendering* was verified by forcing the initial theme) — the
controlled-radio→`onChange`→`setTheme` path is standard React; confirm with a
real click. (b) `--executing`/`--thinking` legacy tokens vs the new `--success`
family — check for redundancy.

## P1–P3 + all surfaces (2026-06-10)

Shipped across 5 parallel worktrees, reviewed + verified, merged to `main`.

**P1 — UX & persistence (admin):**

- **System/auto theme**: a `system` option resolves via
  `matchMedia('(prefers-color-scheme: dark)')` → nebula (dark) / daylight
  (light); the `index.html` first-paint script handles it too.
- **Server-side per-user persistence**: `UserPreferencesSchema` gained a `theme`
  enum (stored in the existing `preferences` JSON — no migration);
  `ThemeProvider` hydrates from `me.user.preferences.theme` and `setTheme`
  writes through `PATCH /api/auth/me/preferences` (localStorage stays the
  pre-login fallback). The PATCH is a per-key *partial merge*: each settings
  surface (appearance, notifications, starred) sends only its own slice,
  provided keys overwrite, absent keys are preserved, and an explicit `null`
  clears a key. This replaced the earlier theme-only-merge special case, which
  still let a non-theme single-key write (e.g. `fontScale`) wipe `pushEnabled`/
  `pushQuietHours`. Verified live: theme-only PATCH persists + preserves other
  prefs; a `contrast` server pref hydrates on reload.
- **Swatches** on each Appearance card (rail/accent/tx preview).

**P2 — design-system tokens (admin `styles.css`, `:root` only):** typography
(`--font-family-body/-mono`, `--font-size-base`, `--line-height-base`,
`--font-weight-*`), radius (`--radius-sm..xl`, `--radius-panel`), motion
(`--duration-*`, `--easing-standard`) + a global `prefers-reduced-motion` block,
tokenized `::selection`.

**P3 — more themes + all surfaces:**

- **11 themes** total: nebula, midnight, daylight, forest, ocean, sunset, rose,
  graphite, sandstone + **High Contrast** (`[data-theme="contrast"]`, AA+).
- **Mobile** (`mobile/`): `src/lib/theme.ts` (dark+light semantic palettes
  mirroring nebula/daylight) + `theme-context.tsx`; resolves from the user's
  server theme preference / `useColorScheme`; screens swept of hardcoded color.
- **Public web** (`web/`): palette tokenized into CSS vars + a
  `prefers-color-scheme: dark` variant.
- **Desktop** (`desktop/`): Tauri window chrome follows the theme (overlay
  titlebar / themed window background).
- **UOA hosted sign-in** (`api/src/services/uoa-auth.ts`): the login click sends
  the selected applied theme to the API, which carries it into UOA's
  `config_url`; the signed config JWT then emits matching concrete color values
  because the IdP page can't read our CSS vars.

**Verified**: admin/api `tsc` + `eslint --max-warnings 0` + `vite build`, web +
mobile `tsc`/build, desktop `cargo check` — all green. Playwright: 11 cards +
swatches render; daylight, sandstone, and high-contrast render correctly; server
theme hydrates on reload.

## Control sizing lives in `styles.css`, not at the call site (2026-07-26)

`styles.css` declares its component classes **unlayered**, while Tailwind's
utilities land in the `utilities` cascade layer. Unlayered rules beat every
layer, so a Tailwind utility can never override a property that a component
class already sets: `className="admin-input h-8 w-auto py-0 text-sm"` kept
`.admin-input`'s `width: 100%` and `padding: 10px 12px` and only `h-8` applied
— a 32px box with 22px of padding and border, which sliced the `<select>`
label in half. That was the Settings → Members role dropdown.

Rules for compact inline controls:

- Size them with **`admin-input-compact` / `admin-button-compact`**, not with
  Tailwind padding, width, or font-size utilities. Both modifiers resolve to the
  same 30px box, so a select and a button align in one row.
- Both are written as two-class selectors (`.admin-input.admin-input-compact`)
  so they win regardless of where they sit relative to their base class — within
  one unlayered stylesheet, single-class modifiers are decided by source order.
- Only override a property Tailwind can actually reach. Height, margin, and flex
  utilities work on these controls; padding, width, and font-size do not.

Adding a `@layer components` wrapper around the component classes would let
utilities win everywhere, but it would silently activate the currently-inert
padding utilities at every `admin-input` call site — a separate, verify-heavy
change, not a side effect to smuggle into a control fix.
