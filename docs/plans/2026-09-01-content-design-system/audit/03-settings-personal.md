# Settings A (personal) — content design-system audit

Slice: `admin/src/pages/settings/{SettingsProfilePage,SecuritySettingsPage,session-device,SecretsPage,NotificationsPage,notification-preference-controls,AppearancePage,settings-shared}.tsx`, `pages/settings/profile/AvatarPanel.tsx`, `pages/settings/appearance/{ColoursPanel,TypePanel}.tsx`, `pages/settings/push/{ApnsCard,FcmCard,shared}.tsx`, `PushCredentialsPage.tsx`, `components/shared/{AvatarUploadPanel,CircleImageCropper}.tsx`.

All 17 files read in full. `session-device.ts` is a pure string-formatting helper (no markup) — not cited below except where relevant. Two files rendered by this slice but **not** in the file list — `components/features/settings/{ActiveSessionsTable,SecretMetadataTable,CreateSecretDialog}.tsx` — were skimmed for context only (their own line-level findings belong to whichever slice owns `components/features/settings/`); they are cited only where they establish a pattern this slice's page diverges from or matches.

---

## 1. Body containers & sections

Every page in this slice is `SettingsPanel` (`settings-shared.tsx:53`) → one `<section className="admin-card p-4">` per topic, `SectionLabel` as the section heading, `mt-{2,4}` internal rhythm. This is the most consistent category in the slice:

- `SettingsProfilePage.tsx:69,104` — two `admin-card p-4` sections in a `grid gap-4 xl:grid-cols-2`.
- `SecuritySettingsPage.tsx:44,110,125` — three `admin-card p-4` sections (one nested inside `<div className="max-w-3xl">`).
- `NotificationsPage.tsx:172,341,361(PushPreferenceCard),384,448` — five `admin-card p-4` sections, laid out in a form-column / muted-channels-column split via `grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]` (`:335`) — the one bespoke multi-column body shape in the slice, distinct from every other page's plain `xl:grid-cols-2` or single column.
- `ColoursPanel.tsx:34`, `TypePanel.tsx:14` — `admin-card max-w-3xl p-4` (note the extra `max-w-3xl` on the section itself, not on a wrapper — the only two files that cap width this way).
- `ApnsCard.tsx:87`, `FcmCard.tsx:59` — `admin-card p-4`, laid out via `PushCredentialsPage.tsx:24` `grid gap-4 xl:grid-cols-2`.
- `AvatarUploadPanel.tsx:56` — `admin-card p-4` (same shape, reused by `AvatarPanel`).
- `SecretsPage.tsx:59` breaks the pattern: its one section is `admin-card overflow-hidden` with **no** `p-4` — internal padding is hand-spelled per sub-block instead (`px-4 py-3` header at `:60`, then the table body has its own cell padding). This is the only card in the slice with no section-level padding, because it needs a full-bleed table.

Max-width is inconsistent and un-derived: `max-w-sm` (SecuritySettingsPage password form, `:46`), `max-w-3xl` (SecuritySettingsPage password fallback wrapper `:121`; ColoursPanel/TypePanel section), `max-w-5xl` (SecretsPage body `:49`), `max-w-md` (CircleImageCropper panel `:158`) — five different caps with no visible rule for which page gets which.

Nested "card in a card" recurs: `SettingsProfilePage.tsx:107,115,121` (`admin-card p-3` metadata boxes inside an `admin-card p-4` section), `NotificationsPage.tsx:452,464` (`admin-card` list rows inside an `admin-card p-4` "Muted channels" section), `push/ApnsCard.tsx:91` / `FcmCard.tsx:63` use `rounded-md bg-[color:var(--main-hover)] p-3` instead of nesting another `admin-card` for the same "status box inside a card" job — a third shape for what is structurally the same nested-block need (see §9).

**Verdict: consistent** for the outer shell (`SettingsPanel` + `admin-card p-4` + `SectionLabel`) — this is the strongest pattern in the slice and the one worth generalising outward. The nested-box sub-pattern is **two-variants** (`admin-card p-3` vs `rounded-md bg-[var(--main-hover)] p-3`) — see §9 for the fix.

---

## 2. Tables & data lists

No `<table>` element exists directly in this slice's own files (the one real data table, `SecretMetadataTable.tsx`, lives outside it and already does the right thing: `ExpandableTable` + `admin-table`, cited for context in §9/§12 below).

Where this slice needs to show a list, it always reaches for a **div-based card list**, and does so three different ways for the same "row of items with a right-aligned action" shape:

1. `NotificationsPage.tsx:456-486` — muted-channel rows: `<div className="admin-card flex items-center justify-between gap-4 p-3">` per channel, truncated title + uppercase meta line on the left, `NotificationToggle` on the right, an `sr-only role="status"` for the pending state instead of a spinner.
2. `SettingsProfilePage.tsx:107-128` — "Session" facts as three separate `admin-card p-3` blocks stacked in a `grid gap-3`, each a label/value pair, not an interactive list but structurally the same repeated-card idiom.
3. `push/ApnsCard.tsx:90-102` / `FcmCard.tsx:62-72` — the "Configured" status is a single `rounded-md bg-[var(--main-hover)] p-3` block containing `PushStatusRow` label/value lines (`push/shared.tsx:3-8`), not cards at all — a flat block with internal rows instead of a list of cards.

So the same underlying need (a handful of key/value or entity rows grouped under a section) ships as: repeated `admin-card p-3` siblings, or one `rounded-md bg-[var(--main-hover)] p-3` box with internal flex rows. No shared "metadata list" or "row list" primitive exists for either.

**Verdict: many-variants** — n/a for `<table>` specifically in this slice, but real drift in the "list of small facts/rows" idiom. Missing primitive: a `MetaList`/`RowList` component wrapping label/value or entity rows (candidate: generalise `push/shared.tsx`'s `PushStatusRow` + a container, or `SecretMetadataTable`'s row shape) would absorb all three variants above plus §9's key-value duplication.

---

## 3. Pagination & loading more

**N/A in this slice.** Nothing here paginates — sessions, secrets, channels and push credentials are all rendered as complete, unpaged lists (the tables that *would* need it, `ActiveSessionsTable`/`SecretMetadataTable`, live outside this slice). No hand-rolled prev/next, no "Load more", no infinite scroll anywhere in these 17 files.

---

## 4. Forms

This is the largest category by file count; findings below are exhaustive per file.

**Field layout — three distinct label shapes for the same "label above control" idea:**

- **Bare text in `<label>`, no `<span>` wrapper:** `SecuritySettingsPage.tsx:47-57` (`<label className="grid gap-1 text-sm text-[color:var(--tx2)]">Current password<input .../></label>`), same at `:58-68`, `:69-79`; `NotificationsPage.tsx:402-412,413-423,424-439` (quiet-hours Start/End/Timezone).
- **`<span>`-wrapped text in the same implicit `<label>`:** `push/ApnsCard.tsx:105-146` (five fields, all `<label>...<span>Label</span><input/></label>`), `push/FcmCard.tsx:75-78`.
- **Explicit `<label htmlFor>` + `<input id>` pairing with a separate uppercase-tracked class**, used by the one *dialog* form in the slice's orbit, `components/features/settings/CreateSecretDialog.tsx:106-180` (`text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]`) — this is the same visual language as `SettingsProfilePage.tsx:23-24`'s `fieldLabelClass` constant, but that constant is used only for **read-only** key/value display, never wired to an actual `<label htmlFor>` in this slice. No in-slice form uses `fieldLabelClass`-style uppercase labels for an actual input; every real input label in this slice is a plain `text-sm text-[color:var(--tx2)]` sentence-case label instead. So the "uppercase tracked label" idiom exists in two unrelated places (a read-only fact label here, a form-field label in the sibling dialog file) and never meets.

None of the three shapes carries a required marker. The only `required` attributes in the whole slice are the three HTML5 `required={quietHoursEnabled}` props at `NotificationsPage.tsx:408,419,430` — invisible to a sighted user (no asterisk, no "(required)" text) and the *only* place in the slice a control is conditionally required. Nowhere else does any field indicate optionality either way.

Help/description text: some fields carry it (`push/ApnsCard.tsx` placeholders act as the only guidance: `"ABC123DEFG"`, `"TEAM123456"`), `CreateSecretDialog.tsx:121-123` uses an explicit `<p className="text-xs text-[color:var(--tx3)]">` under the field, `SecuritySettingsPage.tsx` relies on `placeholder` only ("At least 8 characters" as the sole hint that the field has a length rule) — three different vehicles for the same "how do I fill this in" job, with placeholder-as-instructions being the weakest (vanishes once the user types).

**Controls:**

- `admin-input` is used consistently for every text/password/select control that isn't a raw file input (`SecuritySettingsPage.tsx:51,62,73`; `NotificationsPage.tsx:405,416,427`; `push/ApnsCard.tsx:112,121,130,139`) — no `admin-input-sm` usage anywhere in this slice.
- **Raw, unstyled `<input type="file">`** in three places, with zero shared styling: `AvatarUploadPanel.tsx:85-91` (`className="hidden"`, driven by a styled button instead — the one correct pattern, since the native file chooser UI is hidden entirely), vs. `push/ApnsCard.tsx:107` (`<input accept=".p8" onChange={onFileChange} type="file" />` — no class at all, browser-default file button rendered inline in the form) and `push/FcmCard.tsx:77` (same). So one file-upload flow hides the native input behind a themed button+dialog (avatar), and the other hides nothing and ships the browser's own file-picker button next to `admin-input`-styled siblings — a visible, unthemed control sitting in an otherwise themed form.
- Radio-as-card: `ColoursPanel.tsx:40-77` and `TypePanel.tsx:20-59` both use `<fieldset className="mt-4 grid gap-3 border-0 p-0 md:grid-cols-3"><legend className="sr-only">…</legend>` wrapping `<label>` cards with a `sr-only` native `<input type="radio">` and a `ring-2 ring-[color:var(--accent)]` selected state — the one real fieldset/`<legend>` usage in the slice, and the two files agree byte-for-byte on the shape (good — see "good model" below).
- Toggle: **two independent switch implementations** for the identical on/off semantic. The shared primitive `components/primitives/Switch.tsx:8-31` (`h-6 w-11` track, `border-[color:var(--border-strong)]`/`bg-[color:var(--overlay-weak)]` off, `bg-[color:var(--on-accent)]` thumb) is never imported anywhere in this slice. Instead `NotificationsPage.tsx`/`notification-preference-controls.tsx` define and use their own `NotificationToggle` (`notification-preference-controls.tsx:28-56`): `h-7 w-12` track, `border-[color:var(--sep)]`/`bg-[color:var(--scrim)]` off, and — the real defect — **raw Tailwind named colours** `text-white` (`:40`) and `bg-white` (`:51`) on the thumb instead of a theme token (`Switch.tsx` uses `bg-[color:var(--on-accent)]` for exactly this). `NotificationToggle` is used 9 times across `NotificationsPage.tsx` (`:179,352,393,472`) and `notification-preference-controls.tsx` (`:84,144`×6-item map). This is a straight duplicate-primitive case, not a variation with a reason.

**Fieldset/grouping:** only the two radio-card panels (§ above) use a real `<fieldset>`. Every other multi-field group (password form, quiet-hours trio, APNs' five fields) is a bare `<form className="grid gap-3">` / `<div className="grid gap-3 md:grid-cols-3">` with no `<fieldset>`/`<legend>`, so a screen-reader user gets no "these three fields are one group" announcement for quiet hours the way they do for theme/text-size.

**Form action row placement — three placements for "submit this form":**

1. **Bottom-left, inline in the form**, not right-aligned: `SecuritySettingsPage.tsx:80-90` — `className="admin-button admin-button-primary justify-self-start …"`.
2. **Bottom-left/flex-wrapped, inline**, mixed with secondary actions: `push/ApnsCard.tsx:148-176`, `push/FcmCard.tsx:80-108` — `<div className="flex flex-wrap gap-2">` holding Save + Test + Remove together, no right alignment at all.
3. **Detached into the page header**, not in the form body: `NotificationsPage.tsx:318-333` — the Save button is a `PageHeaderAction` with `form="notification-preferences-form"` + `submit: true`, rendered by `AdminPageHeader` (out of scope for styling, but the *placement decision* — top-right sticky header vs. bottom-of-form — is in scope) rather than sitting under the fields like every other form in the slice.
4. `CreateSecretDialog.tsx:186-197` (dialog, out-of-list but instructive) uses the fourth shape: bottom-**right** `justify-end gap-2` Cancel/Submit pair — the only right-aligned footer in the slice's orbit, and it's in the one dialog-form, following `ConfirmDialog`'s own footer shape.

So four form-footer placements exist for what is always the same "commit this form" action, with no visible rule for which page gets which.

**Disabled/pending state:** consistently expressed as a boolean disable + label swap to an ellipsis verb (`"Saving…"` `ApnsCard.tsx:154`, `FcmCard.tsx:86`; `"Saving…"` `SecuritySettingsPage.tsx:89`), but the *ellipsis character* is inconsistent: real `…` (U+2026) in `ApnsCard`/`FcmCard`/`SecuritySettingsPage`/`AvatarUploadPanel`'s implicit label, vs. three literal dots `"..."` in `NotificationsPage.tsx:324,327` (`'Saving...'`, `'Loading...'`) and `notification-preference-controls.tsx` has no pending state of its own (delegates to caller). `QueryState`'s own doc comment flags this exact drift ("the ellipsis was sometimes three dots") — this slice is a live instance of it.

**Autosave vs explicit save — real, unreconciled split:**

- **Autosave, no button at all:** `ColoursPanel.tsx:61` (`onChange={() => setTheme(themeOption.id)}`), `TypePanel.tsx:41` (`onChange={() => setFontScale(option.id)}`) — theme and text size commit on click.
- **Autosave with async feedback but no form/button:** `AvatarPanel.tsx` — crop-and-save is one action inside `CircleImageCropper`, no separate "form" step; `NotificationsPage.tsx`'s "Muted channels" column (`:293-312`) — each toggle click calls `saveChannelMute` immediately, with an optimistic flip (`setChannelMuteOverrides`, `:299`) rolled back on failure.
- **Explicit submit, single button, whole-form commit:** the password form, the quiet-hours + push-preferences form (one Save for the whole left column), APNs/FCM credential forms.

Three genuinely different save models coexist on **adjacent sections of the same page** (`NotificationsPage.tsx`: the left column is explicit-submit, the right "Muted channels" column is autosave-per-row) with no visual cue distinguishing which behaviour a given control has.

**Verdict: many-variants.** Missing/underused primitives: `Switch` (exists, unused here — `NotificationToggle` should be deleted in favour of it), a shared `FormField` (label+control+help, to end the bare/span/htmlFor three-way split), and a settled form-footer placement convention.

---

## 5. Validation & field errors

**`FormFieldError` (`fieldErrorAria`/`fieldErrorProps`/`renderFieldError`) is imported by zero files in this slice** (grepped directly — no hits). There is no field-level, per-input error anywhere: no `aria-invalid`, no `aria-describedby`, no boxed inline error under a single field.

All "validation" in this slice is one of:

- **Submit blocked by a disabled button**, with no explanatory text at all: `push/ApnsCard.tsx:151` (`disabled={!file || !teamId.trim() || !topic.trim() || upload.isPending}`), `push/FcmCard.tsx:83`, `CreateSecretDialog.tsx:192` (`disabled={pending || !canSave}`) — a person who leaves a required field blank simply finds the button inert, with no message telling them why.
- **Form-level error, surfaced after a failed submit, via `FeedbackBanner`** (i.e. the shared `Notice` primitive, `role="alert"`): `SecuritySettingsPage.tsx:25-28` — client-side "New passwords do not match." check *and* server-error catch both funnel through the same `FeedbackBanner`.
- **Form-level error, surfaced after a failed submit, as a bare paragraph** — a second, un-unified shape for the identical situation: `CreateSecretDialog.tsx:184` — `<p className="text-sm text-[color:var(--danger-text)]" role="alert">{formError}</p>`. Same intent (post-submit, `role="alert"`, danger-red text) as `FeedbackBanner`, but hand-rolled instead of reusing it, and with none of `Notice`'s border/background/padding treatment — a plain red sentence rather than a banner.
- **Async-action error, as a bare `<div>` (no `role="alert"`)**: `AvatarUploadPanel.tsx:95` — `{error ? <div className="mt-3 text-sm text-[color:var(--danger-text)]">{error}</div> : null}` — same red-text idiom as `CreateSecretDialog` but *without* `role="alert"`, so this one is not announced to assistive tech at all, unlike its two siblings.

So for the exact same job — "tell the person their action failed, in red text, near the button they clicked" — this slice alone ships three shapes: `Notice`-backed banner (bordered, padded, `role="alert"`), bare paragraph (`role="alert"`, no border/background), and bare div (no `role`, no border/background). All timing is correctly submit/async-triggered rather than per-keystroke, matching `FormFieldError`'s own doc note that `role="alert"` belongs only there — that part is done right everywhere.

**Verdict: many-variants** (three renderings of "form-level error text", zero field-level errors). This slice never needed field-level errors (every form here is 1-4 fields with obvious single failure modes), so the win is smaller than it looks, but the `FeedbackBanner` vs. bare-`role="alert"`-paragraph vs. bare-div-no-role split across `SecuritySettingsPage`/`CreateSecretDialog`/`AvatarUploadPanel` is a direct, fixable inconsistency — collapse all three onto `FeedbackBanner`/`Notice`.

---

## 6. Feedback after actions

Three distinct vehicles for "the action you just took succeeded or failed," beyond the validation-error overlap already covered in §5:

1. **`FeedbackBanner` (`Notice`, tone success/danger, `role="alert"`)** — the majority pattern: `SecuritySettingsPage.tsx:91`, `SecretsPage.tsx:58`, `NotificationsPage.tsx:445,490` (two independent `SettingsFeedback` states on one page: `preferenceFeedback` and `channelFeedback`) and `NotificationsPage.tsx:186-188` inside `BrowserNotificationsSection` (a *third* independent feedback state on the same page). All persistent-until-replaced (not auto-dismissing), placed directly under the control/form that triggered them.
2. **`PushResultBanner` (`push/shared.tsx:23-41`)** — a **deliberately** un-unified third tone system for the *same* success/danger semantic, used by `ApnsCard.tsx:179` and `FcmCard.tsx:111`. The file's own comment (`:10-21`) documents the divergence explicitly: borderless tinted block vs. `Notice`'s always-bordered block, and says explicitly that unifying it is "a design decision, not a refactor one." This is the one place in the slice where an inconsistency is self-aware and intentionally deferred rather than accidental — worth flagging to the synthesiser as a pre-scoped decision, not a bug to silently fix.
3. **Bare error text, no success counterpart** (`AvatarUploadPanel.tsx:95`) — covered in §5; notably this flow has **no success feedback at all** — saving a new avatar just closes the cropper and the new image appears; there is no transient "Saved" anywhere in the avatar flow, unlike every other mutation in the slice.

Placement is consistent within each vehicle (always directly below the triggering control/form, never a toast, never top-of-page), which is good; the *choice of vehicle* is not.

**Verdict: two/three-variants.** `Notice`/`FeedbackBanner` is the majority; `PushResultBanner` is a knowingly-deferred fork (leave for the synthesiser to decide, cite the comment); `AvatarUploadPanel`'s missing-success-state is a real gap, not a style choice.

---

## 7. Loading / error / empty states

**`QueryState` and `EmptyState` are imported by zero files in this slice.** Every loading/empty state here is hand-rolled, and every one differs from `QueryState`'s and `EmptyState`'s baked-in shapes (centred `text-sm`/`--tx3` line for loading/error/empty; dashed-border card for empty):

- **Page-level loading:** none of the five pages shows a page-level loading state at all — `NotificationsPage` renders the full form immediately and gates individual controls on `preferencesHydrated` (disabled + label text) instead of blocking the render (`:320-327`); `SecuritySettingsPage`/`SecretsPage` pass `isLoading` straight down into the (out-of-slice) table components rather than branching at the page.
- **Inline "checking" text**, not a spinner or the `QueryState` loading line: `NotificationsPage.tsx:128-129` — `if (configLoading) return 'Checking availability...'` (three-dot ellipsis again, see §4) inside `describeState()`, rendered as ordinary body text (`:177`), no distinguishing loading styling from the other three states in that same function.
- **Empty list, hand-rolled, not `EmptyState`:** `NotificationsPage.tsx:451-454` — `{channels.length === 0 ? (<div className="admin-card p-3 text-sm text-[color:var(--tx3)]">No channels available.</div>) : ...}`. This reuses `admin-card p-3` (the same class as a normal populated row, §2) rather than `EmptyState`'s dashed-border/`--overlay-weak` treatment — an empty muted-channels list is visually indistinguishable from a populated list with one plain row in it.
- **No error state at all** for several queries that can fail: `useChannels()` (`NotificationsPage.tsx:196`), `useTeams()`/`useAuthProviders()`/`useCurrentOrganization()` (`SettingsProfilePage.tsx:30-32`) are all destructured with silent `?? []`/optional-chaining fallbacks — a failed fetch here renders as if the data were simply empty, the exact failure mode `QueryState`'s own doc comment calls out as the reason it exists ("a failed fetch rendered as an empty list").

**Verdict: many-variants**, and the biggest missed-primitive case in the slice: `QueryState` would directly absorb the loading/error handling `SettingsProfilePage` and `NotificationsPage` silently skip, and `EmptyState` would fix the muted-channels empty row.

---

## 8. Status chips & badges

Minimal chip usage in this slice's own files — most badge/pill work lives in the out-of-list table components (`SecretMetadataTable.tsx:149` already uses `Pill radius="chip" size="sm" tone={statusTone[...]}` correctly, a good model to point the synthesiser at). Within the 17 in-scope files:

- No hand-rolled `rounded-full`/`uppercase tracking` chip exists as a *status* indicator — the closest thing is `ColoursPanel.tsx:20-27`'s theme swatches (`h-3 w-3 rounded-full` colour dots, `:23`) and `NotificationsPage.tsx:468` (`mt-1 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]` for the "Muted"/visibility caption under a channel name) — a bare uppercase-tracked text label doing a badge's semantic job (channel state: muted or its visibility) without any chip container, colour-by-tone, or `Pill` reuse. This is a real instance of "status conveyed as plain uppercase text" that a `Pill tone="muted"` would normalize, especially since `SecretMetadataTable.tsx` two files over does use `Pill` for an almost identical "state word" (`active`/`expired`/`revoked`).
- `push/ApnsCard.tsx:92`/`FcmCard.tsx:64` — `<div className="font-semibold text-[color:var(--accent)]">Configured ✓</div>` is another ad-hoc "status" indicator (a coloured checkmark line), not a `Pill`.

**Verdict: n/a-to-two-variants in this slice** (too little chip usage to call "many"), but the one real chip-shaped opportunity (`NotificationsPage.tsx:468`'s muted/visibility caption, and the Apns/Fcm "Configured ✓" line) both reinvent status-as-plain-text instead of reaching for `Pill`.

---

## 9. Detail / key-value views

No `<dl>` anywhere in the slice. Three unreconciled shapes for "a label and its value," all doing the identical job:

1. **Stacked, label-above-value, in its own `admin-card p-3` box:** `SettingsProfilePage.tsx:107-128` — `fieldLabelClass` (`:23-24`, `'text-[11px] uppercase tracking-[0.16em] text-[color:var(--tx3)]'`) as the label, value in a `mt-0.5 text-[color:var(--tx)]` line below it, repeated for Session ID / Issued / Auto redirect, each its own card. The *same* label class is reused inline (not through the constant — re-typed verbatim) at `:87,91,95` for Organization/Team/Provider, but there those three sit in one `grid gap-3` **without** individual card boxes — so even within this one file, "Profile" facts (no card per row) and "Session" facts (card per row) render the identical label/value shape two different ways one section apart.
2. **Inline, label-left/value-right, no box of its own, packed into a shared tinted container:** `push/shared.tsx:3-8` (`PushStatusRow`) — `<div className="flex justify-between gap-3"><span className="text-[color:var(--tx3)]">{label}</span><span className="break-all text-right font-mono text-xs text-[color:var(--tx)]">{value}</span></div>`, used 5× in `ApnsCard.tsx:93-100` and 3× in `FcmCard.tsx:65-70`, always inside the `rounded-md bg-[var(--main-hover)] p-3` wrapper described in §1/§2.
3. **Field-labelled read-only rows reusing `fieldLabelClass` but never through the shared constant** — the constant lives in `SettingsProfilePage.tsx` and is not exported/shared, so `push/shared.tsx`'s `PushStatusRow` independently reinvented a label treatment (`text-[color:var(--tx3)]`, no uppercase/tracking this time) rather than importing anything.

The two containers differ too: `admin-card p-3` (opaque bordered box, §1) vs `rounded-md bg-[var(--main-hover)] p-3` (borderless tinted box) — the same "boxed group of facts" idea rendered with two different visual languages depending on which page you're on.

**Verdict: many-variants.** Clear missing primitive: a `KeyValueRow`/`MetaList` (label+value, mono-or-not, stacked-or-inline variants) would absorb `fieldLabelClass`, `PushStatusRow`, and the ad-hoc Session/Profile blocks in one move — same primitive gap identified in §2.

---

## 10. In-content filters, search boxes & toolbars

**N/A in this slice.** No filter row, search input, select-filter, date picker, or count summary exists anywhere in these 17 files — every list here (sessions, secrets, muted channels, theme options) is short and unfiltered, and no page shows an item count ("34 items").

---

## 11. Typography & spacing inside content

**Headings:** `SectionLabel` (default `xs`, `text-xs tracking-[0.2em]`) is the only heading component used, in every file that has a section — fully consistent. One raw heading exists outside it: `SecretsPage.tsx:61` — `<h2 className="font-semibold text-[color:var(--tx)]">Available secrets</h2>`, a real `<h2>` with no size utility at all (inherits browser default ~1.5em), the only heading in the slice not going through `SectionLabel` or a small `font-semibold text-[color:var(--tx)]` sub-heading line (the "Profile"/"Session ID" pattern used everywhere else, e.g. `SettingsProfilePage.tsx:71`, `NotificationsPage.tsx:176,345,388`).

**Muted text tokens:** `--tx2` and `--tx3` are both in heavy use, with an apparent (but never stated) convention — `--tx2` for body/description sentences (`SecuritySettingsPage.tsx:112`, `NotificationsPage.tsx:177,346`), `--tx3` for meta/label/hint text (`fieldLabelClass`, `PushStatusRow`'s label span, helper `<p>`s) — the convention holds throughout this slice with no violations found, which is worth telling the synthesiser explicitly since it's an implicit rule nowhere written down.

**`text-xs`/`text-sm` mix:** both are used per their apparent roles (`text-sm` for body/description, `text-xs` for meta/hint/label) consistently; the one deviation is `push/shared.tsx:6`'s value column using `text-xs` for what is data (a value), not metadata — a mono value shown smaller than its own label reads backwards versus `SettingsProfilePage.tsx:88` where the value (`mt-0.5 text-[color:var(--tx)]`, no explicit size — inherits the parent's `text-sm`) is the same or larger than its `text-[11px]` label.

**Padding scale:** `p-3` and `p-4` dominate (see grep counts in §1/§9); `p-5` appears once (`CircleImageCropper.tsx:158`, the modal panel), `p-1`/`p-2` appear only as micro-padding inside `PushStatusRow`'s wrapper divs. No `p-6` anywhere in this slice.

**Border radius:** `rounded-md` (8px-ish, Tailwind default) used for the `push/shared.tsx`/`ApnsCard`/`FcmCard` status boxes; `admin-card`'s own unlayered 12px radius for every section card (can't be overridden per the `styles.css:1947-1970` comment — call sites here don't try); `rounded-full` for switches/radio-dot swatches/pill-shaped elements; `rounded-xl` only in `CircleImageCropper.tsx:171` (the crop stage) and `rounded-[40px]` for the rounded-square crop mask (`:202`) — a one-off bespoke radius value not drawn from any scale, needed because it's a crop-mask geometry rather than a content box, so likely fine as a special case but worth flagging as a raw magic number.

**Border tokens:** `--sep` is the only border token used anywhere in this slice (every card, every input, every divider) — no `--line` or `--border-strong` usage found except inside the (unused-here) `Switch` primitive's own off-state border. Fully consistent.

**Verdict: consistent-to-two-variants.** Typography/spacing/border-token usage is the second-strongest area of this slice (after §1); the only real findings are the unsized `<h2>` in `SecretsPage.tsx:61` and the `PushStatusRow` value/label size inversion.

---

## 12. Destructive & confirm flows with forms in dialogs

This slice's own files contain **no destructive-confirm flow** — removing a push credential (`ApnsCard.tsx:166-173`, `FcmCard.tsx:98-105`), removing an avatar (`AvatarPanel.tsx:74-83`), and revoking a secret (`SecretsPage.tsx:22-30`) all fire immediately on click with **no confirmation step at all** — no `ConfirmDialog`, no `window.confirm`, nothing. This is worth flagging even though it's an absence rather than a variant: three irreversible-ish actions (delete a push credential used in production, remove your profile photo, revoke a live secret reference other systems may depend on) skip confirmation entirely, while the admin has a dedicated `ConfirmDialog` primitive built for exactly this and used elsewhere in the app.

The one form-in-a-dialog in this slice's orbit, `CreateSecretDialog.tsx` (out of the file list but the dialog `SecretsPage.tsx` opens), does use the shared `Dialog` shell correctly (`:96-103`) — good model, cited in §4/§5.

`CircleImageCropper.tsx` (in scope, used by `AvatarUploadPanel`/`AvatarPanel`) is itself a modal-with-form-controls (zoom slider + Cancel/Save) but **does not compose the shared `Dialog` shell at all** — it hand-rolls its own scrim (`:151-154`, `fixed inset-0 z-50` + `style={{ background: 'var(--scrim-strong)' }}`, duplicating `Dialog.tsx`'s `SCRIM_STYLE`), its own panel (`admin-card w-full max-w-md p-5`, vs. `Dialog`'s `create-channel-panel` class), its own title/description block with no close (×) button at all — the only modal in the slice with no dismiss affordance other than clicking Cancel or Escape — and only partial a11y: it calls `useModalA11y` directly (`:50`, so it does get focus-trap/Escape/focus-restore) but never `useOverlayDismiss`, so **clicking the scrim does not close it**, unlike every `Dialog`-based modal in the app. This is exactly the pre-`Dialog` pattern the shared component's own doc comment (`Dialog.tsx:15-19`) says it was built to retire ("roughly half of them shipped with no keyboard or screen-reader affordances at all") — `CircleImageCropper` is a surviving instance of that older pattern, not yet migrated.

**Verdict: many-variants / n/a-adjacent** — no true destructive-confirm exists in-slice (a real gap: three delete/revoke actions with zero confirmation), and the one dialog owned by this slice (`CircleImageCropper`) is a hand-rolled modal that predates and bypasses `Dialog`.

---

## Notable files

- **Good model:** `ColoursPanel.tsx` / `TypePanel.tsx` — identical `fieldset`/`legend`/`sr-only`-radio/card pattern in both files, correctly grouped, correctly labelled, autosave with instant visual confirmation (selection ring) standing in for a save-feedback banner. This is the one place in the slice where two independently-written files agree on a nontrivial pattern byte-for-byte.
- **Worst offender:** `CircleImageCropper.tsx` — the only hand-rolled modal in the slice (bypasses `Dialog`, no close button, no scrim-click dismiss), combined with a raw unthemed-adjacent `<input type="file">` pattern one file up the tree (`push/ApnsCard.tsx`/`FcmCard.tsx`) and the `NotificationToggle` duplicate-of-`Switch` with actual raw Tailwind colours (`text-white`/`bg-white`) in `notification-preference-controls.tsx` are close runners-up.

## Raw colours / Tailwind named colours found

- `notification-preference-controls.tsx:40` — `text-white`.
- `notification-preference-controls.tsx:51` — `bg-white`.
  (Both should be `--on-accent`, matching `Switch.tsx`'s equivalent thumb, which this component duplicates.)
- `ColoursPanel.tsx:5-16` — literal hex swatch values (`#000000`, `#facc15`, …) in `THEME_SWATCHES`. Likely intentional (these are previews of the actual per-theme colours, not chrome), flagged for the synthesiser to confirm rather than treated as a defect.

---

## Top 5 unification wins for this slice

1. **One switch, not two.** Delete `NotificationToggle` (`notification-preference-controls.tsx:28-56`, 9 call sites) in favour of the existing `components/primitives/Switch.tsx` — also removes the only raw `text-white`/`bg-white` in the slice.
2. **One "form/action failed" banner.** Collapse `CreateSecretDialog.tsx:184`'s bare `role="alert"` paragraph and `AvatarUploadPanel.tsx:95`'s bare non-alert div onto `FeedbackBanner`/`Notice` — three shapes for one job, one of which isn't even announced to assistive tech.
3. **One key-value/meta-row primitive.** `SettingsProfilePage.tsx`'s `fieldLabelClass` boxes, `push/shared.tsx`'s `PushStatusRow`, and the ad-hoc "Profile" vs. "Session" split inside `SettingsProfilePage.tsx` itself are three renderings of the same label/value fact — one `KeyValueRow`/`MetaList` component (stacked and inline variants) ends all three.
4. **`QueryState`/`EmptyState` adoption.** Zero uses in this slice today; `NotificationsPage.tsx`'s hand-rolled "Checking availability..."/"No channels available." pair and the silent `?? []` fallbacks on `SettingsProfilePage.tsx`'s org/team/provider queries are the concrete instances to convert first (the latter also fixes a real "failed fetch looks like empty" bug, not just a style mismatch).
5. **Migrate `CircleImageCropper` onto the shared `Dialog` shell** (and add a confirm step to the three unconfirmed destructive actions — remove-avatar, remove-push-credential, revoke-secret) — the one place in this slice still hand-rolling scrim/panel/focus-trap wiring `Dialog` exists specifically to standardise, and the one place a delete happens with no "are you sure."
