# Settings B (organisation) — content design-system audit

Slice: `admin/src/pages/settings/OrganizationSettingsPage.tsx`, `organization/*`
(CallProviderSettingsPanel, ConversationalSetupPanel, LogoPanel,
WorkspaceAvatarPanel), `StatusesPage.tsx`, `statuses/*`, `ConnectionsPage.tsx`,
`connections/*`, `SettingsMembersPage.tsx`, `WorkspaceMemberPeople.tsx`,
`WorkspaceMembersSection.tsx`, `components/features/members/*`,
`components/features/settings/*`, `components/shared/MemberManagementPopup.tsx`.

Files covered (19, exhaustive):
`pages/settings/OrganizationSettingsPage.tsx`,
`pages/settings/organization/CallProviderSettingsPanel.tsx`,
`pages/settings/organization/ConversationalSetupPanel.tsx`,
`pages/settings/organization/LogoPanel.tsx`,
`pages/settings/organization/WorkspaceAvatarPanel.tsx`,
`pages/settings/StatusesPage.tsx`,
`pages/settings/statuses/status-components.tsx`,
`pages/settings/statuses/StatusEmojiPicker.tsx`,
`pages/settings/ConnectionsPage.tsx`,
`pages/settings/connections/ConnectionCard.tsx`,
`pages/settings/connections/ConnectionPermissions.tsx`,
`pages/settings/SettingsMembersPage.tsx`,
`pages/settings/WorkspaceMemberPeople.tsx`,
`pages/settings/WorkspaceMembersSection.tsx`,
`components/features/members/PersonAgents.tsx`,
`components/features/settings/ActiveSessionsTable.tsx`,
`components/features/settings/CreateSecretDialog.tsx`,
`components/features/settings/SecretMetadataTable.tsx`,
`components/shared/MemberManagementPopup.tsx`.

No raw hex colours or Tailwind named-colour utilities (`text-emerald-500` etc.)
were found anywhere in this slice — clean on that specific defect.

---

## 1. Body containers & sections

Every top-level page in this slice uses `SettingsPanel` (from
`settings-shared.tsx`) for its header/scroll frame — consistent. Inside the
body, the near-universal content wrapper is `<section className="admin-card p-4">`
plus a `SectionLabel` heading:
`CallProviderSettingsPanel.tsx:106`, `ConversationalSetupPanel.tsx:18`,
`LogoPanel.tsx:68`, `WorkspaceAvatarPanel.tsx:81`, `StatusesPage.tsx:190,219,279,384`,
`ConnectionCard.tsx:94`, `SettingsMembersPage.tsx:243,273`,
`WorkspaceMembersSection.tsx:291,346,351`.

Divergences:
- **Max-width handling is inconsistent.** `OrganizationSettingsPage.tsx:86`
  wraps its sections in `<div className="grid max-w-3xl gap-4">`, but
  `LogoPanel.tsx:68` and `WorkspaceAvatarPanel.tsx:81` — its only children —
  *also* redeclare `max-w-3xl` on their own `<section>` (`admin-card max-w-3xl p-4`),
  a redundant/defensive second cap. `ConnectionsPage.tsx:35` uses a third
  shape, `mx-auto flex max-w-3xl flex-col gap-4` (flex, not grid). `StatusesPage.tsx:189`
  and `SettingsMembersPage.tsx:242`/`WorkspaceMembersSection.tsx:290` set no
  max-width at all, going full-bleed with `xl:grid-cols-2` /
  `xl:grid-cols-[340px_minmax(0,1fr)]` instead.
- **Row cards vs section cards use different padding**: section wrappers are
  `admin-card p-4`, but row cards (`MemberRow` `SettingsMembersPage.tsx:74`,
  `WorkspaceMemberRow` `WorkspaceMemberPeople.tsx:63`, `InvitationRow`
  `WorkspaceMembersSection.tsx:65`) are `admin-card p-3`. `ConnectionCard.tsx:94`
  is also a "row" (one per connection) but uses `p-4` like a section, not `p-3`
  like the other row types.
- **`ConversationalSetupPanel.tsx:18-22`** is the only panel with a *second*,
  bare heading inside its `SectionLabel` block — `<h2 className="font-semibold
  text-[color:var(--tx)]">Conversational agent setup</h2>` with no explicit
  text-size class (every other card-internal title elsewhere in the slice is
  `text-sm font-semibold`). Every other panel has exactly one heading
  (`SectionLabel` alone, its text naming the panel's purpose).
- `ConnectionsPage.tsx` never uses `SectionLabel` at all — its body opens with
  a bare `<p>` of prose instead of any labelled section.

**Verdict: many-variants.** Existing primitive `SectionLabel` + `.admin-card`
is the right base, but max-width and card padding/level (section vs row) are
undocumented per-file decisions.

## 2. Tables & data lists

Only two real `<table>`s exist in the whole slice, both `.admin-table` wrapped
in `ExpandableTable`: `ActiveSessionsTable.tsx:52` and
`SecretMetadataTable.tsx:103`. Header cells are identical between them
(`px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em]
text-[color:var(--tx3)]`) and row padding matches (`px-4 py-3`). But:
- `ActiveSessionsTable.tsx:18-22,50` wraps the whole `ExpandableTable` in an
  extra local `TableFrame` (`overflow-hidden rounded-xl border`); `SecretMetadataTable.tsx:102`
  returns the bare `ExpandableTable` with no outer frame — two tables in the
  same feature area (`components/features/settings/`) with different outer
  chrome.
- Loading state differs: `ActiveSessionsTable.tsx:69-78` renders hand-rolled
  `animate-pulse` skeleton rows; `SecretMetadataTable.tsx:125-130` renders a
  plain "Loading secrets…" `role="status"` text row. (Per `QueryState`'s own
  doc, a skeleton is a legitimate opt-out — but two *different* opt-outs for
  sibling tables is still drift.)
- Responsive handling differs: `ActiveSessionsTable` hides its "Last active"
  column at `hidden … sm:table-cell` and folds it into the primary cell's
  subtitle on narrow screens; `SecretMetadataTable` has no responsive column
  hiding and instead pins `min-w-[46rem]`, relying entirely on
  `ExpandableTable`'s horizontal scroll.

Everywhere else in the slice, "tables" are actually **card lists**, each
hand-rolled independently with no shared list/row primitive:
- `admin-card p-3` rows in a `grid gap-2` parent: `MemberRow`
  (`SettingsMembersPage.tsx:73-137`), `WorkspaceMemberRow`
  (`WorkspaceMemberPeople.tsx:62-160`), `InvitationRow`
  (`WorkspaceMembersSection.tsx:64-159`).
- `Link` rows using `hoverCardClass`: `StatusList`
  (`status-components.tsx:61-98`).
- `<ul>/<li>` rows with a hover-only background, no card/border at all:
  `PersonAgents.tsx:30-47`, `UnassignedAgents` (`PersonAgents.tsx:79-93`).
- `<ul>/<li>` rows separated by `border-t … first:border-t-0` dividers (no
  card, no hover state): `CallProviderRow` (`CallProviderSettingsPanel.tsx:88-98`).
- `admin-card p-4` rows, one per connection: `ConnectionCard.tsx:94`.

Five distinct row shapes for "a list of things", none sharing an
implementation.

**Verdict: many-variants.** A shared `ExpandableTable`/table baseline exists
for two files but is unused by the rest; no shared card-row/list primitive
exists at all — this is the single biggest gap in the slice.

## 3. Pagination & loading more

`PaginationFooter` is used exactly once, in `ActiveSessionsTable.tsx:133-146`
(client-side slice, `PAGE_SIZE = 6`). No other list in the slice paginates:
`SecretMetadataTable` (same folder, same shape of problem) renders every
secret unpaginated; `StatusesPage`, `ConnectionsPage`,
`SettingsMembersPage`/`WorkspaceMembersSection` member and invitation lists
all render full unpaginated lists with no "load more" affordance of any kind.

**Verdict: n/a-leaning-inconsistent** — the one list that paginates does so
correctly via the shared primitive; every sibling list (including one in the
very same component folder) simply doesn't paginate at all, which is a
completeness gap more than a style gap. `PaginationFooter` is the right
primitive if/when the others need it.

## 4. Forms

Field-layout patterns, at least four distinct shapes in this slice:
1. **Label-wraps-input, sentence case** (`text-sm text-[color:var(--tx2)]`
   label text, `grid gap-1`): `OrganizationSettingsPage.tsx:90-99` (name),
   `SettingsMembersPage.tsx:276-319` (add-member form, four fields),
   `WorkspaceMembersSection.tsx:190-213` (invite form). Most common pattern.
2. **`htmlFor`/`id`-paired, uppercase micro-label** (`text-xs font-semibold
   uppercase tracking-[0.16em] text-[color:var(--tx3)]`, label and control as
   siblings, not nested): `CreateSecretDialog.tsx:104-182`, all four fields.
   This is a third label typography distinct from `SectionLabel`'s own two
   sizes and from pattern 1's sentence-case label.
3. **No visible label at all**, `placeholder`/`aria-label` only:
   `StatusesPage.tsx` schedule-kind select, schedule-label input, date/time
   inputs, timezone input (lines 283-347), rule-scope/channel/project/agent
   selects and instructions textarea (lines 388-453).
4. **Prose paragraph doing double duty as the label**, with `aria-label` on
   the control for a11y only: `CallProviderSettingsPanel.tsx:34-70`
   (`aria-label={`Call provider for ${team.name}`}` on the `<select>`, no
   `<label>` element), `ConversationalSetupPanel.tsx` (Switch's own `label`
   prop, no visible text label).

Controls: `admin-input` used everywhere for text/select/textarea — no raw
unstyled `<input>`s. `admin-input-compact` (dense variant) used only for the
two role `<select>`s (`SettingsMembersPage.tsx:107`,
`WorkspaceMemberPeople.tsx:111`); every other `<select>` in the slice
(StatusesPage, CreateSecretDialog) uses plain `admin-input`, so the compact
variant's applicability isn't rule-based. `Switch` is used for every boolean
in the slice (`ConversationalSetupPanel`, `StatusesPage` agentEnabled/
ruleAgentEnabled, `ConnectionCard` resource toggle) — no checkboxes anywhere,
genuinely consistent.

No required-field marker (`*`) is used anywhere; the HTML `required`
attribute is used silently on a couple of controls (`StatusesPage.tsx:305,312`
date inputs, `CreateSecretDialog.tsx:173` project select) with no visual cue.

Form action placement: page-embedded forms consistently left-align their
primary submit with `justify-self-start` inside a `grid` form
(`OrganizationSettingsPage`, `SettingsMembersPage`, `StatusesPage` ×3,
`WorkspaceMembersSection` invite form). The one dialog-hosted form,
`CreateSecretDialog.tsx:186-197`, right-aligns Cancel+Save with
`flex justify-end gap-2 pt-1` — a different, but context-appropriate,
placement rule (matches `ConfirmDialog`'s own footer). Worth naming as
"two variants, split cleanly by page-form vs. dialog-form" rather than random
drift.

Dirty-tracking exists only in `OrganizationSettingsPage.tsx:68-69` (`dirty`
comparison gates Save); no other form in the slice tracks dirty state — e.g.
`StatusesPage`'s "Save status" button is always enabled once a label is
present, resave-able with no changes.

**Verdict: many-variants.** No shared `FormField` label/control primitive
exists to normalise the four label shapes; `admin-input`/`Switch` reuse itself
is solid.

## 5. Validation & field errors

`FormFieldError` (`fieldErrorAria`/`renderFieldError`/`fieldErrorProps`) is
**not imported anywhere in this slice.** Every error message is hand-rolled,
in at least six slightly different treatments:
- `text-sm … role="alert"`: `CallProviderSettingsPanel.tsx:95`,
  `ConversationalSetupPanel.tsx:36`.
- `text-sm`, **no `role="alert"`**: `LogoPanel.tsx:127`,
  `WorkspaceAvatarPanel.tsx:137`.
- `text-xs … role="alert"`: `SettingsMembersPage.tsx:131`,
  `WorkspaceMemberPeople.tsx:155`, `WorkspaceMembersSection.tsx:153`.
- Bordered banner-row (`border-t … px-4 py-2`, `role="alert"`):
  `ActiveSessionsTable.tsx:132`.
- Bare `<p>`, no margin, `role="alert"`: `CreateSecretDialog.tsx:184`.
- `text-[11px]`, **no `role` at all**: `ConnectionPermissions.tsx:117`.
- No error surface at all for its own mutations: `ConnectionCard.tsx`
  (resync/disconnect/deleteData have no try/catch or error state shown).

None of the seven adopt `FormFieldError`'s boxed treatment
(`inlineErrorClass` — bordered `--danger-soft` box), and none use
`aria-invalid`/`aria-describedby` on the offending control — `aria-invalid` is
not used anywhere in the slice. Roughly half of the hand-rolled errors omit
`role="alert"` outright.

No per-keystroke validation exists anywhere (consistent with the primitive's
own contract that `role="alert"` belongs only on submit-triggered errors —
every site here does set/clear on submit, which is correct even where the
markup differs).

**Verdict: many-variants**, and this is the worst-covered category in the
slice relative to an existing, ready-made primitive
(`components/shared/FormFieldError.tsx`) that nothing here uses.

## 6. Feedback after actions

At least four distinct idioms for "tell the person their action worked or
failed":
1. **`FeedbackBanner`** (persistent until next submit): `OrganizationSettingsPage.tsx:107`,
   `SettingsMembersPage.tsx:327`, `WorkspaceMembersSection.tsx:227,295-319`
   (also reused here for a load-error banner, not just post-submit feedback).
2. **`Notice tone="danger"`** used directly (bypassing `FeedbackBanner`):
   `ConnectionsPage.tsx:47-49` for a query-load failure.
3. **Bespoke neutral-toned success text**, no tone styling at all:
   `WorkspaceAvatarPanel.tsx:138-140` — `notice` state rendered as
   `text-sm text-[color:var(--tx2)]`, i.e. the same muted grey as ordinary
   help text, not a "success" colour. `LogoPanel.tsx` has no success feedback
   at all (silent success, error-only).
4. **Bare per-row danger text** with no Notice/FeedbackBanner involvement:
   every row component in §5 above (`MemberRow`, `WorkspaceMemberRow`,
   `InvitationRow`, `CallProviderRow`, `ConversationalSetupPanel`) — these are
   transient action-feedback too, just spelled as a plain paragraph.

Placement is consistent within each idiom (banner sits directly under/above
the triggering form; row errors sit at the bottom of their row card), but the
four idioms coexist without any rule for which applies where.

**Verdict: many-variants.** `FeedbackBanner`/`Notice` exist and are
under-used relative to the number of hand-rolled alternatives in the same
slice.

## 7. Loading / error / empty states

`QueryState` is **not imported anywhere in this slice**, despite the slice
hand-rolling its exact loading/error/empty triad at least five times:
- `CallProviderSettingsPanel.tsx:112-120` — ternary:
  `teams.isLoading ? <p>Loading teams…</p> : teams.data?.length ? <ul>… : <p>No teams are available.</p>`.
- `ConnectionCard.tsx:195-230` — same ternary idiom for the resources list.
- `ConnectionsPage.tsx:44-92` — explicit isLoading/isError/empty branches
  (comment explains the deliberate `QueryState` opt-out: error renders as a
  `Notice`, empty renders as a CTA card, neither of which `QueryState` can
  represent — a legitimate, documented exception, and the empty-with-CTA card
  here is a genuinely good pattern, see "good model" below).
- `StatusesPage.tsx` — **no loading state at all** for `useStatuses()` (data
  defaults to `[]`, so "loading" and "genuinely empty" render identically);
  its empty state (`StatusesPage.tsx:210-212`) is hand-rolled dashed-border
  text that **does not match** the shared `EmptyState` component's own look:
  `rounded` (not `rounded-xl`), no `bg-[color:var(--overlay-weak)]` fill,
  `p-4` (not `p-5`).
- `SettingsMembersPage.tsx` — no loading state for the local People list, and
  **no empty state at all** if `users` is empty (silently renders nothing).
  `WorkspaceMembersSection.tsx:328-332` does have an explicit "no members"
  text row for its (different) UOA-roster list.
- `ActiveSessionsTable.tsx:68-84` uses a genuine skeleton (a legitimate
  `QueryState` opt-out per its own doc) but `SecretMetadataTable.tsx:125-130`,
  sitting in the same folder for a near-identical table, uses a plain-text
  "Loading secrets…" row instead — two different opt-outs for two sibling
  tables.

**Verdict: many-variants**, and — like §5 — this is a case where the shared
primitive exists, fits the majority of these call sites' actual shape
(`isLoading`/`isError`/`refetch` + one-line states), and is used nowhere.

## 8. Status chips & badges

`Pill` is the dominant chip and is used with matching tone semantics in:
`StatusList` (Active → success), `ConnectionCard.tsx:101-109` (connection
health), `ConnectionPermissions.tsx:88-105` (risk level + granted/blocked/
declined), `SecretMetadataTable.tsx:149` (secret status),
`SettingsMembersPage.tsx:95` / `WorkspaceMemberPeople.tsx:87` (Deactivated),
`WorkspaceMembersSection.tsx:85` (Needs approval).

Drift within that otherwise-consistent usage:
- Every call site above except `SecretMetadataTable` and the
  Deactivated/Needs-approval pills explicitly passes `uppercase={false}`
  (sentence case, since these carry real words like "Healthy"/"Granted"). But
  `SecretMetadataTable.tsx:149` leaves `uppercase` at its default `true`, so
  `active`/`expired`/`revoked` render shouted+tracked while visually adjacent
  status pills elsewhere in the same settings area render sentence-case.
  `SettingsMembersPage`/`WorkspaceMemberPeople`'s "Deactivated" pill and
  `WorkspaceMembersSection`'s "Needs approval" pill likewise leave the
  uppercase default on.
- `ConnectionCard.tsx:101-109` adds `className="font-semibold"` on top of
  `uppercase={false}` — within contract per `Pill`'s own doc (weight is a
  caller concern once uppercase is off) but the only call site in the slice
  doing so.
- `WorkspaceMemberPeople.tsx:93-97` hand-rolls a bespoke "Owner" badge instead
  of `Pill`, with a code comment explaining `Pill`'s muted fill
  (`--overlay-weak`) reads as invisible on this particular card background and
  `--main-hover` is used instead. Deliberate and documented, but it's a second
  chip implementation sitting directly beside a `Pill` in the same component.
- `ActiveSessionsTable.tsx:102-104` hand-rolls a "This device" chip
  (`bg-[color:var(--accent-soft)] text-[color:var(--accent)]`, `text-[10px]
  uppercase tracking-[0.16em]`) instead of `Pill`. This is one of the four
  call sites `Pill.tsx`'s own doc comment names as a known, currently
  unconverted `--accent`-fill outlier — confirmed still present here.

**Verdict: two-variants** (Pill, used well but with an uppercase-default
inconsistency, vs. two documented hand-rolled outliers) — closer to
`consistent` than any other category in this slice, `Pill` is the right
primitive and mostly is being used as one.

## 9. Detail / key-value views

Exactly one real key-value view in the slice: `ConnectionCard.tsx:139-168`,
a `<dl className="mt-3 grid gap-2 sm:grid-cols-2">` of four `<dt>`/`<dd>`
pairs (`dt` via the bare `sectionTitleClass` string, `dd` as
`text-xs text-[color:var(--tx)]`), each pair boxed in its own
`rounded border border-[color:var(--sep)] px-2 py-1.5` tile. No other file in
the slice renders a comparable metadata/detail view (`StatusesPage`'s "status
detail" panel is a form, not a `<dl>`).

**Verdict: n/a in this slice** (single instance, nothing to compare against)
— but see §11: this exact "bordered `rounded` tile" shape independently
recurs three more times elsewhere for non-`<dl>` content, which is the
stronger signal.

## 10. In-content filters, search boxes & toolbars

`MemberManagementPopup.tsx:87-107` is the only search/filter affordance in
this whole slice: a bordered wrapper
(`border-[color:var(--border-strong)] bg-[color:var(--overlay-weak)]`)
containing a `SearchIcon` and a deliberately bare `<input>`
(`bg-transparent … outline-none`, not `admin-input` — the border lives on the
wrapper, not the input). No page-level list in this slice — `StatusesPage`,
`ConnectionsPage`, `SettingsMembersPage`, `WorkspaceMembersSection` — offers
any search or filter control at all, despite several rendering unbounded
lists (all org members, all statuses, all connections).

No count-summary toolbar exists ("34 items" above a list). The closest
analogues are counts baked into row subtitles, not toolbars:
`StatusList` (`status-components.tsx:85-87`, "N schedules · N rules" per
status row) and `MemberManagementPopup.tsx:70` ("{totalMembers} member(s)"
under its dialog title).

**Verdict: n/a in this slice** for page-level filters (none exist to compare);
the one search-input treatment that does exist is unique to
`MemberManagementPopup` and not reused by anything else here.

## 11. Typography & spacing inside content

Headings: `SectionLabel` (default `xs`, `div`) is the dominant section
heading, used correctly across ~14 sections. `sectionTitleClass` (the bare
string export) is used for `<dt>`/`<h3>` where `SectionLabel`'s element union
can't reach — correct, documented use (`ConnectionCard.tsx:141` etc.,
`ConnectionPermissions.tsx:164`). Card-row titles are ad hoc
`font-semibold text-[color:var(--tx)]` with an explicit `text-sm` almost
everywhere (`MemberRow`, `WorkspaceMemberRow`, `ConnectionCard`'s `<h2>`)
except `ConversationalSetupPanel.tsx:22`'s `<h2>`, which carries no explicit
size class at all — the one outlier.

Muted-text split is broadly consistent: `--tx2` for readable secondary prose
(descriptions, captions under headings, select-adjacent explanations) vs.
`--tx3` for tertiary/quiet text (`SectionLabel` itself, timestamps, empty
states, field help copy). One exception: `WorkspaceAvatarPanel.tsx:138-140`'s
success notice uses `--tx2` where a "this worked" message arguably wants a
success tone (see §6).

Text-size mix includes several **arbitrary micro-sizes** duplicating `Pill`'s
own `sm` size token (`text-[10px]`) as raw literals rather than going through
the component: `ActiveSessionsTable.tsx:102` ("This device", `text-[10px]`),
`WorkspaceMemberPeople.tsx:94` ("Owner", `text-[10px]`),
`SettingsMembersPage.tsx:95`/`WorkspaceMemberPeople.tsx:87` and other `Pill`
call sites correctly avoid this since `Pill` owns its own sizing — but the two
hand-rolled badges from §8 re-derive the exact same 10px/tracking values by
hand. Table header cells (`ActiveSessionsTable`, `SecretMetadataTable`) both
use `text-[11px]` consistently between themselves, but that's still a
one-off arbitrary value rather than a named scale step.

Padding scale is a three-tier ad hoc mix: `p-3` for row cards, `p-4` for
section cards, and `p-6` for exactly one hero empty-state card
(`ConnectionsPage.tsx:51`) — no documented rule ties padding to card role.

Border tokens: `--sep` is used almost universally for hairline
borders/dividers/box outlines across every file. `--border-strong` appears
exactly once as a content border, in `MemberManagementPopup.tsx:91`'s search
wrapper — otherwise unused in this slice for content (as opposed to control)
chrome.

Radius: three registers coexist with no evident per-element-type rule —
`rounded` (4px: `StatusEmojiPicker` clear button, `StatusesPage` schedule/rule
item boxes, `ConnectionCard`/`ConnectionPermissions` inner tiles),
`rounded-lg` (8px: `StatusEmojiPicker` popover), `rounded-xl`
(`ActiveSessionsTable`'s `TableFrame`, `MemberManagementPopup`'s panel — note
this Tailwind utility resolves to the redefined 20px per `styles.css:1944-1945`,
not Tailwind's default 12px). **One genuinely repeated, unnamed shape** worth
flagging: the "inner metadata tile" — `rounded border border-[color:var(--sep)]
px-2 py-1.5` — appears identically in `ConnectionCard.tsx:140,148,154,162,200`
(dl tiles + resource rows) and structurally matches `StatusesPage.tsx:255,357,466`'s
schedule/rule item boxes (`rounded border border-[color:var(--sep)] p-3`) and
`ConnectionPermissions.tsx:80`'s capability row (`rounded border … px-3 py-2`)
— four independent files converging on the same bordered-tile idea at
slightly different padding, with no shared component behind any of them.

**Verdict: many-variants**, but with one clear emergent shape (the bordered
metadata/item tile) that is the strongest single candidate for a new
primitive in this whole slice.

## 12. Destructive & confirm flows with forms in dialogs

`ConfirmDialog` is **not used anywhere in this slice**, despite at least two
destructive two-step flows that duplicate its purpose by hand:
- `StatusesPage.tsx:159-169,228-243` — inline `confirmingDelete` state: first
  click on "Delete" arms it (button label swaps to "Confirm delete"), a
  second click commits, `onBlur` disarms. No modal, no consequence sentence —
  the label swap alone is the entire warning.
- `ConnectionCard.tsx`'s `DangerButton` (lines 42-72) — an independently
  authored, functionally identical `armed`/label-swap/`onBlur`-reset pattern,
  used twice (Disconnect, Delete imported data). Different variable names,
  same shape as `StatusesPage`'s hand-rolled version — two parallel
  implementations of the same interaction inside one slice.
- By contrast, `SecretMetadataTable.tsx:151-160`'s Revoke button and
  `ActiveSessionsTable.tsx:115-122`'s Revoke button fire **immediately on
  click with no confirmation step of any kind** — not even the two-click arm
  pattern — for actions of comparable destructiveness sitting in the same
  general settings area as the two arm-pattern implementations above. Three
  different confirmation strengths (modal / two-click-arm / none) for
  similarly destructive actions.

`CreateSecretDialog.tsx` is the slice's only real "form inside a `Dialog`"
and is a good citizen: built on the shared `Dialog` shell, footer is
`flex justify-end gap-2 pt-1` with Cancel (secondary) + Save (primary — not
`admin-button-danger`, correctly, since creating a secret isn't destructive),
matching `ConfirmDialog`'s own footer convention.

**Verdict: many-variants.** `ConfirmDialog` exists, is the obvious fit for
both hand-rolled arm-patterns, and is used by neither; the two Revoke buttons
have no confirmation at all.

---

## Good model

`CreateSecretDialog.tsx` — builds cleanly on the shared `Dialog` shell,
correct footer convention, and its `buildSecretCreateInput` pure-function
pattern (form state → validated input, `canSave` derived from calling it
again) is exactly the kind of small, testable seam other forms in the slice
lack. `ConnectionsPage.tsx`'s empty-state card (loading/error/empty ternary
with a documented, deliberate `QueryState` opt-out and a real CTA) is also a
good, self-aware pattern worth generalising into an "empty state with action"
variant.

## Worst offender

`StatusesPage.tsx` (499 lines) — the largest file in the slice and the one
with the most category hits: no loading state, a non-`EmptyState` empty box,
four unlabeled-field forms, a hand-rolled two-click delete-confirm duplicating
`ConnectionCard`'s separate implementation, and three independently-styled
"item row" boxes (schedule rows, rule rows) that don't match `ConnectionCard`'s
near-identical tiles. It's simultaneously where the "unlabeled form field"
and "bordered metadata tile" patterns are most concentrated.

## Top 5 unification wins for this slice

1. **Bordered metadata/item tile → one primitive.** The identical
   `rounded border border-[color:var(--sep)]` tile shape is hand-rolled 4
   separate times at slightly different padding: `ConnectionCard.tsx` (dl
   tiles + resource rows, ×5), `StatusesPage.tsx` (schedule/rule item rows,
   ×2 shapes), `ConnectionPermissions.tsx` (capability rows). One
   `MetadataTile`/`ItemRow` component would collapse all of them.
2. **`QueryState` → the 5 hand-rolled loading/error/empty ternaries.**
   `CallProviderSettingsPanel`, `ConnectionCard`'s resources list,
   `StatusesPage`'s statuses list (currently has *no* loading state and a
   non-`EmptyState` empty box), `SettingsMembersPage`'s People list (currently
   has *no* empty state at all), `SecretMetadataTable`'s loading row.
3. **`ConfirmDialog` → the 2 hand-rolled two-click arm patterns +
   2 no-confirmation Revoke buttons.** `StatusesPage`'s delete-status,
   `ConnectionCard`'s `DangerButton` (used twice), plus adding a confirm step
   to `SecretMetadataTable`'s and `ActiveSessionsTable`'s currently-unconfirmed
   Revoke actions — four call sites, one shell.
4. **`FormFieldError` → the 7+ hand-rolled error-line treatments.** Six
   different spacing/size/role combinations across
   `CallProviderSettingsPanel`, `ConversationalSetupPanel`, `LogoPanel` (no
   `role="alert"`), `WorkspaceAvatarPanel` (no `role="alert"`),
   `SettingsMembersPage`, `WorkspaceMemberPeople`, `WorkspaceMembersSection`,
   `ActiveSessionsTable`, `CreateSecretDialog`, `ConnectionPermissions` (no
   `role` at all) — none use the existing primitive or `aria-invalid`/
   `aria-describedby`.
5. **One card-row/list-item primitive** for the five independently-shaped
   "list of things" patterns: `admin-card p-3` rows (members/invitations),
   `hoverCardClass` Link rows (statuses), plain `<ul>/<li>` rows (agents),
   `border-t`-divided `<li>` rows (call providers), `admin-card p-4` rows
   (connections) — same underlying need (avatar/icon + title + subtitle +
   trailing chip/actions), five different implementations.
