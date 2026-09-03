# Shared dialogs, forms & the stylesheet — content design-system audit

Slice: `admin/src/components/shared/{CreateChannelDialog,ChannelSettingsDialog,ChannelMembersPopup,MemberManagementPopup,OversizePasteDialog,SessionDebugDialog,ConfirmDialog,Dialog,EmojiPickerPanel}.tsx`, `admin/src/components/shared/channel-members/*`, `admin/src/components/features/channels/{RunStopContinue,CallerCallDialog,DocumentStreamDialog,SecretCaptureDialog,ThoughtProcessDialog}.tsx`, plus `admin/src/styles.css` (content classes + token set).

All paths below are relative to `admin/src/` unless stated otherwise. `MemberManagementPopup.tsx` is read alongside `ChannelMembersPopup.tsx` because the latter is only ever rendered through it and the search/header markup lives there, not in the named file.

---

## 1. Body containers & sections

Every file in this slice is a dialog/popup, not a page body, so "section" here means the panel shell itself.

- Three different panel-shell implementations coexist for what is visually the same 440px centred card:
  - **The shared shell**: `Dialog.tsx:130-176` — `create-channel-panel` + `create-channel-header`, composes `useModalA11y`/`useOverlayDismiss`, one close-cross SVG.
  - **Hand-rolled, same classes**: `ChannelSettingsDialog.tsx:93-147` reproduces the identical scrim (`position:fixed, inset:0, zIndex:9999, background:'var(--scrim-strong)', backdropFilter:'blur(4px)'`) and `create-channel-panel`/`create-channel-header` markup inline, with its own close-cross SVG (lines 133-146) byte-similar to `Dialog.tsx:159-168`. It composes `useModalA11y`/`useOverlayDismiss` directly instead of through `Dialog`.
  - **Hand-rolled, own classes**: `MemberManagementPopup.tsx:38-85` — a third scrim/panel pair, own border/rounded-xl/max-w-[480px] card, own close button (`h-7 w-7`, lines 73-84) — not `create-channel-panel` at all.
  - **Hand-rolled, phone-tuned**: `SessionDebugDialog.tsx:83-154` — a fourth variant: same scrim recipe, `create-channel-panel` reused for the outer card but with safe-area insets and a 44px (`h-11 w-11`) close button instead of the shell's 28px (`h-7 w-7`).
- `CallerCallDialog.tsx`, `OversizePasteDialog.tsx` use the real `Dialog` shell — no duplication.
- `DocumentStreamDialog.tsx:106-141` and `ThoughtProcessDialog.tsx:82-104` are deliberately outside `Dialog` (documented in-file: need to swallow a window-level Escape, phone full-bleed layout) but both hand-roll yet another scrim/panel pair with their own radius/shadow (`rounded-xl border border-[color:var(--sep)] bg-[var(--panel)] shadow-2xl`) that matches neither `create-channel-panel` nor `MemberManagementPopup`'s card.
- Inside the shared-shell dialogs, body layout is consistently `grid gap-4` at the form level (`CreateChannelDialog.tsx:65`, `ChannelSettingsDialog.tsx:149`, `OversizePasteDialog.tsx:44`, `CallerCallDialog.tsx:119`, `SecretCaptureDialog.tsx` — inline flow, no wrapper grid).
- `SectionLabel` (the primitive) is never imported anywhere in this slice, despite five separate hand-written label strings that are its exact recipe (§11).

**Verdict: many-variants.** Four independent panel-shell implementations for one visual object. `ChannelSettingsDialog` and `MemberManagementPopup` are the two that should have used `Dialog.tsx` and didn't (neither has a documented reason the way `DocumentStreamDialog`/`ThoughtProcessDialog`/`SessionDebugDialog` do in their own comments).

## 2. Tables & data lists

No `<table>` appears anywhere in this slice.

- `ChannelMembersPopup.tsx` + `channel-members/*` render membership as **div rows**, not a table: `rowClass` (`channel-members/styles.ts:2-5`) = `flex items-center gap-3 rounded-lg px-3 py-2` + hover, applied identically in `MemberUserRow.tsx:34,86`, `MemberAgentRow.tsx:36,102,158`. This is a clean, single shared row shape — the best-behaved list pattern in the slice.
- Section headers above each row group: `sectionHeadingClass` (`channel-members/styles.ts:14-17`) = `px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]`, used in `ChannelMembersPopup.tsx:122,170,199`. This is a fourth near-duplicate of the "uppercase label" recipe in §11 (11px/`0.16em` vs the 12px/`0.2em`/`0.16em` variants elsewhere in the slice), and again not `SectionLabel`.
- `CallerCallDialog.tsx:154-166` renders the call-invite list as a real `<ul>`/`<li>` with `divide-y divide-[color:var(--sep)] rounded-md border border-[color:var(--sep)]` — a **third** list shape (bordered/divided `<ul>`) alongside the `rowClass` div-rows and the plain `<div>` empty-line pattern, for structurally the same "name + status" content.
- No sorting, selection, sticky header, or zebra striping anywhere in this slice (none of these lists are long/tabular enough to need it) — not a defect, just out of the table system entirely.

**Verdict: two-variants** (div-row list vs bordered `<ul>`) for the same "rows of people/participants" concept. No shared primitive exists for either — `rowClass`/`sectionHeadingClass` are file-local exports, not promoted alongside `Pill`/`SectionLabel`.

## 3. Pagination & loading more

N/A in this slice — every list here (channel members, call invites, thinking log) is loaded whole, no paging or "load more" affordance appears.

## 4. Forms

- **Label pattern A** (`CreateChannelDialog.tsx:66-107`, `ChannelSettingsDialog.tsx:150-228`): `<label>` above control, `<div className="grid gap-1.5">` wrapper, help text as a plain `<div className="text-xs text-[color:var(--tx3)]">` below the control (`CreateChannelDialog.tsx:90-92`), `.admin-input` on the control. Six fields across the two files repeat this shape near-verbatim.
- **Label pattern B** (`SecretCaptureDialog.tsx:54-67`): `<label className="mt-4 grid gap-1 text-sm text-[color:var(--tx2)]">Value<input .../></label>` — label text and control are children of one `<label>`, sentence-case not uppercase, `text-sm`/`--tx2` not the `text-xs`/uppercase/`--tx3` treatment used everywhere else, no separate help text, no `fieldErrorAria`/`fieldErrorProps` wiring at all.
- **Label pattern C**: `SessionDebugDialog.tsx` has no `<label>` at all — the single textarea carries `aria-label={textareaLabel}` (line 161) instead, because the dialog is a single-control debug surface, not a labeled form.
- Controls: `.admin-input` used throughout (`CreateChannelDialog.tsx:80,120`, `ChannelSettingsDialog.tsx:163,202,221`, `SecretCaptureDialog.tsx:56,60,64`, `SessionDebugDialog.tsx:164` with `admin-input-mono`). No raw unstyled `<input>`/`<select>`/`<textarea>` in this slice.
- Required markers: none of the forms in scope mark a field required (all three fields in `CreateChannelDialog`/`ChannelSettingsDialog` are effectively required but say so only through the submit-disabled state, not a visual `*`).
- Form action row placement: **consistently bottom-right** `flex justify-end gap-2` across `CreateChannelDialog.tsx:133`, `OversizePasteDialog.tsx:64`, `ConfirmDialog.tsx:71`, `SecretCaptureDialog.tsx:70`, `CallerCallDialog.tsx:176`, `SessionDebugDialog.tsx:185`. `ChannelSettingsDialog.tsx:230-271` is the one exception: `flex items-center justify-between` with destructive actions (Archive/Delete) pinned left and Cancel/Save right — a deliberate and reasonable two-zone footer, but the only one of its kind in-slice.
- Disabled/pending state: every submit button disables on its own mutation's `isPending` (`createChannel`/`updateChannel`/`archiveChannel`/`createSecret`/`cancelRun` `.isPending`) — consistent. No file shows a spinner glyph; all use button-text swap ("Saving…", "Sending…", "Continuing…", "Cancelling…") — consistent wording shape, inconsistent verb tenses are fine (different actions).
- Autosave vs explicit save: 100% explicit-save (every mutation fires on click/submit, never on blur/change) — consistent, n/a for autosave.

**Verdict: many-variants** on label markup specifically (three shapes: labeled-above-with-help, label-wraps-control, aria-label-only), **consistent** on controls/footer/pending-state. Missing primitive: no shared `FormField` (label + control + help + error) — `FormFieldError.tsx` only covers the error third of that triad, and its own docstring (`FormFieldError.tsx:17-22`) explicitly says the visual is *not* part of its contract, which is exactly why three visuals now exist.

## 5. Validation & field errors

- `CreateChannelDialog.tsx:78,99-106` and `ChannelSettingsDialog.tsx:161,180-187` both use `fieldErrorAria`/`fieldErrorProps` from `FormFieldError.tsx` correctly (id + `aria-invalid`/`aria-describedby` on the input, `role="alert"` on a **bare** `<div className="text-xs text-[color:var(--danger-text)]">` — deliberately not `renderFieldError`'s boxed treatment, per that helper's own docstring). This is the one place in the slice where the shared a11y contract is actually wired up.
- `SecretCaptureDialog.tsx:69`: `<p className="mt-3 text-sm text-[color:var(--danger-text)]" role="alert">{error}</p>` — has `role="alert"` but **no id, no `aria-describedby` on any control** (the form has three inputs and the error is not tied to any one of them) — does not use `fieldErrorAria`/`fieldErrorProps` at all.
- `OversizePasteDialog.tsx:97-99`: `<p className="text-sm text-[color:var(--danger-text)]">{error}</p>` — **no `role="alert"` at all**, no aria wiring. This is a form-level error (upload failure) rendered as plain text.
- `CallerCallDialog.tsx:170-174`: `<p className="text-sm text-[color:var(--danger-text)]" role="alert">` — has the role, no aria wiring (also form-level/action-level, not field-level, so an id would be moot — reasonable).
- `DocumentStreamDialog.tsx:210-222`: two independent bare `<p>` error lines (`errorCopy` and `actionError`), neither carries `role="alert"`, both `text-[color:var(--danger)]` (note: `--danger` not `--danger-text` — a different token from every other error line in this slice, which all use `--danger-text`).
- Error text colour token check: five of six error surfaces use `--danger-text`; `DocumentStreamDialog.tsx:212,219` alone uses `--danger` (the saturated fill token, meant for icons/borders, not body text) for its two error lines.
- `SessionDebugDialog.tsx:176-178` is the one dialog that renders its error through the shared `Notice` component (`tone="danger" role="alert" radius="xl"`) instead of a bare paragraph — the only boxed error in the whole slice.
- Timing: every error is submit/action-triggered (never per-keystroke) and cleared on the next edit where relevant (`CreateChannelDialog.tsx:83-85`, `ChannelSettingsDialog.tsx:166-168`) — consistent with `FormFieldError.tsx`'s stated contract.

**Verdict: many-variants.** Six error call sites, four different shapes (aria-wired bare line / role-only bare line / no-role bare line / boxed `Notice`), plus a stray wrong-token (`--danger` vs `--danger-text`) in `DocumentStreamDialog.tsx`. Shared primitive exists (`FormFieldError.tsx` + `Notice`) but only 2 of 6 sites use the aria helpers and only 1 of 6 uses `Notice`.

## 6. Feedback after actions

- No success banner/toast appears anywhere in this slice's dialogs themselves — every successful mutation just closes the dialog (`CreateChannelDialog.tsx:50`, `ChannelSettingsDialog.tsx:63,74,84`, `SecretCaptureDialog.tsx:39`) or, for `RunStopContinue.tsx:47-56`, pushes a toast via `useToasts()` (`pushToast({ body:..., title: 'Run continued' })` / `'Could not continue the run'`) — the one file in this slice that talks to the app-level toast system rather than an inline banner.
- Inline persistent feedback: only the error paragraphs covered in §5 (there is no persistent inline "Saved" anywhere in-slice).
- `Notice`/`FeedbackBanner` (the shared primitives) are used exactly once (`SessionDebugDialog.tsx:176`, `Notice` directly — `FeedbackBanner` from `settings-shared.tsx` is not used at all in this slice, expected since it is settings-page-specific).

**Verdict: n/a for success feedback** (no in-slice call site needs it — dialogs close instead), **two-variants for error feedback delivery** (toast for `RunStopContinue`, inline banner/paragraph everywhere else) — reasonable given `RunStopContinue` renders outside a dialog, in the message feed.

## 7. Loading / error / empty states

- `QueryState`/`EmptyState` (the shared primitives) are **not used anywhere in this slice.**
- `ChannelMembersPopup.tsx:221-228`: hand-rolled empty line — `<div className="px-3 py-6 text-center text-sm text-[color:var(--tx3)]">No members match your search.</div>` — same shape as `QueryState`'s empty branch (`text-center text-sm` + `--tx3`) but independently written, different padding (`py-6` vs `QueryState`'s default `py-8`).
- `EmojiPickerPanel.tsx:69-74`: Suspense fallback — `<div className="flex h-64 items-center justify-center text-sm text-[color:var(--tx3)]">Loading emojis...</div>` — a third independent loading-line shape (centered via flex, not `text-center`; fixed `h-64` instead of vertical padding).
- No file in this slice renders an error+Retry state (nothing here fetches a list that can fail independently of its own mutations — membership/emoji data arrives as props).

**Verdict: two-variants** for loading/empty text (centered-flex vs `text-center` padding), both hand-rolled, neither reusing `QueryState`/`EmptyState`. Missing-primitive opportunity is small (`QueryState` wants a `refetch`-bearing query object neither call site has), but the empty-line in `ChannelMembersPopup.tsx` is exactly `EmptyState`'s dashed-card copy without the card — could reasonably become one.

## 8. Status chips & badges

- `channel-members/MemberUserRow.tsx:56` (`<Pill radius="chip" size="sm">user</Pill>`) and `MemberAgentRow.tsx:46,121` (`<Pill ... tone="accent">agent</Pill>` / `PA`) — **the shared `Pill` primitive, used correctly and consistently** for the "what kind of row is this" chip. This is the best-behaved chip usage in the slice.
- `CallerCallDialog.tsx:160-163`: invitation state (`Accepted`/`Declined`/`Missed`/`Cancelled`/`Waiting for response`, from `invitationStateLabel` at lines 29-35) is rendered as a **plain `<span className="flex-shrink-0 text-[color:var(--tx3)]">`** — no chip, no tone mapping (a declined/missed invite reads in the same muted grey as an accepted one). This is the one status-shaped value in the slice that does not use `Pill` and has no tone-per-state at all, unlike every other status surface in the admin (per `Pill.tsx`'s own docstring, twenty other call sites map status → tone).

**Verdict: two-variants** — one exemplary (`Pill` in the member rows) and one that skips chips/tone-mapping entirely (`CallerCallDialog` invite states) where a `Pill` with `tone` keyed off `invite.state` (success/accepted, danger/declined, warning/ringing) would be a direct, low-risk fit.

## 9. Detail / key-value views

No `<dl>` or two-column metadata grid appears in this slice. The closest analogue is `CallerCallDialog.tsx:154-166`, the invite `<li>` row (`name` left, `state` right, `flex items-center justify-between`) — a single-pair key-value row repeated per invitee, not a general detail view.

**Verdict: n/a in this slice.**

## 10. In-content filters, search boxes & toolbars

- `MemberManagementPopup.tsx:87-107` is the only search box in this slice, and it is **fully bespoke**: `<div className="flex items-center gap-2 rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--overlay-weak)] px-3 py-2">` wrapping a `SearchIcon` and a bare `<input className="w-full bg-transparent text-sm text-[color:var(--tx)] outline-none placeholder:text-[color:var(--tx3)]">`. It does **not** use `.admin-input` at all — border colour (`--border-strong` vs `.admin-input`'s `--sep`), background (`--overlay-weak` vs `.admin-input`'s `--panel`), and focus treatment (no `:focus` ring — `.admin-input:focus` adds `border-color: var(--accent)` + a shadow ring, this input has none) are all independently decided.
- Count summary: `MemberManagementPopup.tsx:69-71` — `{totalMembers} member{totalMembers !== 1 ? 's' : ''}` under the title, not beside the search box — a small, singular pattern (only one count summary in this slice, so no variance to report against).
- No date pickers or select-filters appear anywhere in this slice.

**Verdict: n/a for breadth** (only one search box exists here) **but it is a clear defect against the token system**: it is a fifth, independent "input-shaped" recipe alongside `.admin-input`/`.admin-input-sm`/`.admin-input-compact`/`.admin-input-mono`, sharing none of their tokens.

## 11. Typography & spacing inside content

- **The uppercase-label recipe is spelled out five separate times**, each slightly different, none through `SectionLabel`:
  1. `CreateChannelDialog.tsx:68-71,111-114`: `text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]` (×2, identical to each other).
  2. `ChannelSettingsDialog.tsx:152-155,192-195,212-215`: the same string, ×3.
  3. `channel-members/styles.ts:14-17` (`sectionHeadingClass`): `px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]` — 11px, not 12px (`text-xs`).
  4. `MemberManagementPopup.tsx:69` uses plain `text-xs text-[color:var(--tx3)]` (no uppercase) for the member count — not a label at all, included only to show the same token pairing (`text-xs`/`--tx3`) recurring at a third weight/case combination.
  - `SectionLabel.tsx` ships exactly two sanctioned sizes (`xs` = 12px/`0.2em`, `2xs` = 11px/`0.18em`) and this slice's hand-written copies match **neither** exactly: `0.16em` tracking appears nowhere in `SectionLabel`'s own table.
- Body/help text: `text-xs text-[color:var(--tx3)]` for help lines (`CreateChannelDialog.tsx:90`, `ChannelSettingsDialog.tsx:172`) vs `text-sm text-[color:var(--tx2)]` for descriptive prose (`OversizePasteDialog.tsx:45`, `CallerCallDialog.tsx:120`, `SecretCaptureDialog.tsx:51`) — a consistent two-tier split (xs/tx3 = meta, sm/tx2 = body prose) that holds up across the whole slice; the one violation is `SecretCaptureDialog.tsx:54,58,62`'s labels at `text-sm text-[color:var(--tx2)]` where every other file's field labels are `text-xs`/`--tx3` (already flagged in §4 as label-pattern B).
- Padding scale: dialog panel padding is fixed at 24px by `.create-channel-panel` (styles.css:2656-2663) for every shell-based dialog; hand-rolled shells vary — `MemberManagementPopup.tsx` header/search at `px-5 py-4`/`px-5 py-3`, body at `px-2 py-2`; `SessionDebugDialog.tsx` reuses `create-channel-panel`'s 24px card padding. Row padding: `channel-members/styles.ts` rows at `px-3 py-2`; `ChannelMembersPopup.tsx:200,225` ad-hoc rows at `px-3 py-2` and `px-3 py-6` respectively.
- Gap scale: `gap-1.5` (field stacks), `gap-2` (button rows, row internals), `gap-3` (row layout), `gap-4`/`gap-5` (form/dialog body stacks) all appear, each locally consistent within its file but with no documented scale (e.g. `OversizePasteDialog.tsx` body uses `grid gap-4`, `CallerCallDialog.tsx` body uses `grid gap-5` — same "stack of blocks inside a dialog" job, two different gaps).
- Border-radius: `.create-channel-panel` = 14px; `MemberManagementPopup.tsx:56` = `rounded-xl` (20px, per the `--radius-xl` override documented at `styles.css:1944-1946`); `DocumentStreamDialog.tsx:135`/`ThoughtProcessDialog.tsx:98` = `rounded-xl` also; row-level radius is `rounded-lg` (`channel-members/styles.ts:3`) throughout. So the two dialog-panel radii in this slice (14px vs 20px) disagree by nearly 1.5×.
- Border tokens: `--sep` is the default border everywhere (panels, rows, dividers); `MemberManagementPopup.tsx:91` alone reaches for `--border-strong` on its search box (§10); no use of `--line` anywhere in this slice.

**Verdict: many-variants.** Five hand-spelled label strings that should be one `SectionLabel` call, two disagreeing panel radii, and an undocumented gap scale.

## 12. Destructive & confirm flows with forms in dialogs

- `ConfirmDialog.tsx` itself is in-scope and is the clean shared primitive (destructive vs primary confirm colour via the `destructive` prop, pending-gated dismiss, `cancelRef` focus per its own docstring) — but **nothing else in this slice actually calls it.**
- `ChannelSettingsDialog.tsx` hand-rolls **two independent confirm mechanisms** for its two destructive actions on the same footer:
  - **Archive** (lines 235-241, 275-314): opens a second full hand-rolled scrim+panel (`confirmArchive` state) — a second `create-channel-panel` instance nested as a sibling, with its own heading/paragraph/Cancel-Archive footer (lines 289-311). This duplicates `ConfirmDialog`'s entire job (title + body + Cancel/Confirm) in ~35 lines of bespoke markup, and is the reason the file cannot use the shared `Dialog` shell for its outer panel either (per its own comment at lines 90-92).
  - **Delete** (lines 246-253): a **different** confirm mechanism on the very next button — no dialog at all, just a two-click toggle: the button's own label flips from `Delete` to `Confirm delete` (`{confirmDelete ? 'Confirm delete' : 'Delete'}`) and a second click performs the action. So one file ships two different "are you sure" affordances for two buttons three lines apart.
- `DocumentStreamDialog.tsx:250-269` repeats the **same in-place button-toggle confirm** pattern as `ChannelSettingsDialog`'s Delete button: `Stop` → click → `Stop — nothing is saved` (`confirmStop` state), no dialog. It also separately renders `DocumentStreamLeaveConfirm` (a real dialog, out of this slice) for the *leave/close* destructive action — so this one file has two different confirm treatments for two different destructive actions (stop vs leave), matching `ChannelSettingsDialog`'s pattern of splitting confirm strategy per-action within one file.
- `CallerCallDialog.tsx:185-204` (Cancel call / End call) and `SecretCaptureDialog.tsx` (Discard) perform their destructive/discard action **immediately on click, no confirmation step at all** — a third strategy (no confirm) for actions that are at least as consequential as "archive a channel."
- Form-in-dialog layout for the confirm cases that do exist: `ConfirmDialog.tsx:69-94` puts body text above a `flex justify-end gap-2` footer — this is the shape `ChannelSettingsDialog`'s hand-rolled archive-confirm independently arrived at (lines 291-311), just re-typed.

**Verdict: many-variants — the worst-offending category in this slice.** Four distinct "are you sure" strategies in five files (shared `ConfirmDialog` used by nobody in-scope; a hand-rolled second dialog in `ChannelSettingsDialog`; an in-place button-label toggle in both `ChannelSettingsDialog` and `DocumentStreamDialog`; no confirmation at all in `CallerCallDialog`) for actions of comparable severity (archive a channel, stop an in-flight generation, end a live call).

---

## Stylesheet audit (`admin/src/styles.css`)

- **`.admin-table` / `.agents-table`** (styles.css:1684-1714): intentionally-duplicated selector list, not drift — the file's own comment (line 1688) states `.agents-table` is original and `.admin-table` a generic alias so new tables reuse the same zebra/hover/focus rules rather than forking. Genuinely `consistent`, already resolved.
- **`.admin-card`** (styles.css:1972-1976, 12px radius, `--sep`/`--panel`): the file carries an extensive comment (lines 1940-1970) recording that folding the `rounded-xl border ... bg-[color:var(--panel)]` inline string used across ~26 feature panels into this class was **attempted twice and reverted twice** — once because it silently reshaped every one of those panels to a different radius (`--radius-xl` is redeclared to 20px, not Tailwind's default), once (as a `@utility`) because it then let arbitrary Tailwind utilities win against it unpredictably. This is the single most load-bearing piece of prior art for whoever unifies "card" next: the inline `rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]` string is a *second*, deliberately-separate card system, not a bug.
- **`.admin-input` family** (styles.css:1978-2002, 2061-2070, 2087-2089): base class owns `width`/`border`/`radius`/`background`/`color`/`padding` and is **unlayered**, so it wins over co-located Tailwind padding utilities by design (documented at 1988-1990, 2030-2041) — a call site writing `admin-input py-1` silently gets the base 10px/12px padding, not `py-1`. Two dense modifiers exist for different jobs: `.admin-input-sm` (2091-1993: `padding: 4px 8px`, "for controls inside a table row") and `.admin-input-compact` (2061-2070: `padding: 5px 10px`, sized to align with `.admin-button-compact` at a shared 30px box, "for a control that sits inline in a row instead of a form column"). These read as two answers to nearly the same question (dense input in a row) with no documented boundary between "table row" and "inline row" — see the repo-wide tally below.
- **`.admin-sec-hdr` / `.admin-sec-row`** (styles.css:1078-1096): these are **sidebar/navigation** classes (project/team section headers in the rail), not content-body section headers — out of scope per the brief's navigation carve-out, noted only because the brief's class list named them explicitly. Not to be confused with the in-slice `sectionHeadingClass`/label strings in §11, which are a completely independent, unrelated recipe that happens to serve the same visual role inside content.
- **`.admin-status-badge`** (styles.css:1271-1306): a chat-author status-emoji + hover-tooltip component, unrelated to the `Pill`-based "status chip" concept in §8 despite the name overlap — it's a single inline badge with a custom tooltip, not a tone-mapped chip. Its tooltip shadow (`box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35)`, line 1299) is a **raw, non-token colour** — every other shadow in the file that needs black uses `var(--scrim-strong)` or `color-mix(in srgb, var(--scrim-strong) …)` (e.g. `.admin-table-expand-button:hover`'s neighbour at styles.css:2273); this one line still hardcodes `rgba(0,0,0,.35)`.
- **`.admin-expandable-table*`** (styles.css:2216-2294): the one table-adjacent system in this list that is fully coherent — viewport/expand-button/dialog-content all cleanly separated, and `.admin-message-markdown .admin-expandable-table` (2216-2218) shows it is already reused for markdown-rendered tables in chat, not just admin lists.
- **`.kb-*`** (styles.css:2690-2843): knowledge-base rich-text/editor styling (`.kb-prose`, `.kb-editor .ProseMirror`, `.kb-reader`, `.kb-note-highlight*`, wikilink states) — a self-contained typography system for one feature (the knowledge base), not reused by and not relevant to this slice's dialogs/forms. Noted per the brief's class list but out of this slice's actual surface.
- **`.glass-panel`** (styles.css:249-254, 263-267): a translucent/blurred card recipe (`--overlay-strong` border, `--overlay-weak` background, `blur(18px)`) distinct from both `.admin-card` and `.create-channel-panel` — a third "card" look. Not used by any file in this slice; flagged only because it is a third member of the same "what does a card look like" family the stylesheet already carries two other unreconciled answers for.
- **`.create-channel-panel` / `.create-channel-header`** (styles.css:2656-2670): despite the name, this is the **generic dialog-panel class** — `Dialog.tsx`'s own docstring (lines 18-19) and every hand-rolled dialog in this slice (`ChannelSettingsDialog`, `SessionDebugDialog`) all reuse it under this name. It is a fourth card recipe (14px radius, 24px padding, 440px max-width, `--sep`/`--panel`) sitting beside `.admin-card` (12px), `MemberManagementPopup`'s inline `rounded-xl` (20px), and `.glass-panel`.
- **Element rules**: `button, input, select, textarea { font: inherit }` (styles.css:256-261) and `input::placeholder, textarea::placeholder { color: var(--tx3) }` (269-272) are the only bare-element content rules; both are resets, not a competing design (no bare-element border/padding/background is set, so every visible input still requires `.admin-input`).
- **Raw colours found in styles.css near these class families**: `.admin-status-badge .admin-tooltip`'s `rgba(0, 0, 0, 0.35)` shadow (line 1299) and `.admin-compose-emoji-menu`'s `box-shadow: 0 16px 36px rgb(0 0 0 / 18%)` (line 1744, adjacent to the `.agents-table` block, composer-related and out of this slice's component scope but in the swept line range) are the two non-token colours in this region of the file.

### Semantic content tokens that exist

Surface: `--panel`, `--panel-soft`, `--main`, `--main-hover`, `--rail`, `--sb`, `--surface-inverse`, `--surface-inverse-2`.
Border: `--sep`, `--border-strong`, `--line` (the last unused anywhere in this slice).
Overlay/scrim (for hovers, dialog backdrops, subtle fills): `--overlay-weak`, `--overlay`, `--overlay-strong`, `--scrim-weak`, `--scrim`, `--scrim-strong`.
Text: `--tx` (primary), `--tx2` (secondary/body), `--tx3` (muted/meta), `--ink`, `--muted`, `--lnk` (links).
Accent: `--accent`, `--accent-hover`, `--accent-strong`, `--accent-soft`, `--on-accent`, `--thinking` (accent-family foreground, per `Pill.tsx`'s docstring).
State tones (each with `base`/`-soft`/`-border`/`-text` variants): `--danger`/`--danger-soft`/`--danger-border`/`--danger-text`/`--danger-strong`, `--success`/`--success-soft`/`--success-border`/`--success-text`, `--warning`/`--warning-soft`/`--warning-border`/`--warning-text`, `--info`/`--info-soft`/`--info-border`/`--info-text` (info is defined in every theme but is not one of `Notice.tsx`'s three tones — `Notice` supports `danger`/`success`/`warning` only, so an "info" banner has no shared primitive to render through).
`--executing` (single-value, execution-status colour, no soft/border/text siblings — probably a chat/run-status token, not used in this slice).

**Which content concerns have a class vs. live only as Tailwind strings**: body-container radius/border/background (`.admin-card`, `.create-channel-panel`, `.glass-panel` — three classes, no single one used consistently, per above), inputs (`.admin-input` + three modifiers — has a class, well-adopted), tables (`.admin-table`/`.admin-expandable-table*` — has classes, not used in this slice at all), buttons (out of scope, but referenced constantly as `.admin-button*`). **No class exists at all** for: uppercase section/field labels inside a dialog (five hand-written copies in this slice, `SectionLabel` exists as a component but is never reached for it), dense search-boxes (`MemberManagementPopup`'s search input has no class, is fully inline Tailwind), row-list items (`rowClass`/`sectionHeadingClass` are TS constants, not CSS classes, file-local to `channel-members/`), or confirm-dialog footers (each of the four confirm strategies in §12 is independently inline).

---

## `admin-input` + sizing/padding-override tally (repo-wide grep, `admin/src` — brief requires this beyond the slice)

Total `admin-input` occurrences across `admin/src/**/*.tsx`: **217**. Breakdown of the modifier strings that follow it:

- **112** bare `className="admin-input"` — no modifier.
- **20** `admin-input mt-1` (margin-only addition — not an override, since `.admin-input` sets no margin; all 20 are in `BudgetManager.tsx`, `PricingManager.tsx`, `PageEditor.tsx`, `FeedbackComposer.tsx`).
- **13** files use `admin-input-compact` (the 30px dense/inline variant) — `ScheduledTodoTemplate.tsx`, `TodoTemplateEditor.tsx`, `ExecutorCreatePanel.tsx`, `ToolFilterBar.tsx` (×2), `EventTriggerFields.tsx` (×2), `WebhookTriggerFields.tsx` (×4), `TriggerListColumn.tsx`, `CommentComposer.tsx`, `TeamMemberPeople.tsx` (was
`WorkspaceMemberPeople.tsx` at audit time; renamed by commit `4fe11c54`).
- **1** file uses `admin-input-sm` (the 4px/8px table-row-dense variant) — `TodoInstanceCard.tsx:121`, and it stacks `text-xs` on top of it (`admin-input admin-input-sm text-xs` — a **genuine size override attempt**, since `text-xs` is layered/Tailwind and `.admin-input` claims `font-size` unlayered per the stylesheet's own documented rule at styles.css:2030-2041, so this `text-xs` is silently inert).
- **11** occurrences of `min-h-*` stacked on `admin-input` (a legitimate, non-conflicting addition — `.admin-input` sets no height) — `SessionDebugDialog.tsx:164` (in this slice), `ExecutorRunLauncherDialog.tsx:282`, `DeepWaterResearchLauncher.tsx:90`, `EventTriggerFields.tsx:20,38`, `TriggerEditorDialog.tsx:361`, `StatusesPage.tsx:269,449`, plus 4 more via `min-h-[Npx]` bracket syntax.
- **No** occurrences of `admin-input` combined with `py-*`, `px-*`, or a fixed `h-9`/`h-8`-style override were found anywhere in `admin/src` — the codebase already respects the "padding is claimed, do not fight it" rule the stylesheet documents. The only near-miss is the `text-xs` case above, which is inert rather than visibly broken.
- Net picture: two competing dense-variant classes (`-sm` vs `-compact`) with almost all real usage (13 files) on `-compact` and only one lone file on `-sm`, plus one inert-utility mistake (`TodoInstanceCard.tsx`) that a `size` prop on a shared `Input` component would make structurally impossible.

---

## Good model / worst offender

- **Best model in this slice**: `channel-members/MemberUserRow.tsx` + `MemberAgentRow.tsx` + `styles.ts` — one row shape (`rowClass`), consistent `Pill` usage for the type chip, consistent action-button treatment (`actionBtnClass` + tone variants), and a clean split between "current" and "available" row variants that both reuse the same primitives. If this slice unifies around one thing, generalise this.
- **Worst offender**: `ChannelSettingsDialog.tsx` — hand-rolls the entire dialog shell instead of `Dialog` (§1), then hand-rolls a *second*, nested dialog shell for its Archive confirm instead of `ConfirmDialog` (§12), then uses a *third*, different confirm mechanism (in-place button-label toggle) for Delete three lines below it (§12), all while its labels re-type the same uppercase string three times instead of `SectionLabel` (§11). Every category this audit covers shows up as a defect in this one file.

## Top 5 unification wins for this slice

1. **3 hand-rolled dialog shells → `Dialog.tsx`.** `ChannelSettingsDialog.tsx:93-147`, `MemberManagementPopup.tsx:38-85`, and (with justified exceptions already documented in-file) `SessionDebugDialog.tsx`'s panel markup all reproduce `Dialog`'s scrim/panel/header/close-button recipe by hand. Collapsing the first two alone removes ~90 lines of duplicated a11y-relevant markup and the current 3 slightly-different close-button sizes (28px/28px/44px) and z-indices.
2. **4 confirm strategies → `ConfirmDialog.tsx`.** `ChannelSettingsDialog.tsx` (nested hand-rolled dialog for Archive + in-place button-toggle for Delete), `DocumentStreamDialog.tsx` (in-place button-toggle for Stop), and `CallerCallDialog.tsx`/`SecretCaptureDialog.tsx` (no confirmation at all) should converge on the one shared, already-built `ConfirmDialog` that nothing in this slice currently calls.
3. **5 hand-written uppercase-label strings → `SectionLabel`.** `CreateChannelDialog.tsx` (×2), `ChannelSettingsDialog.tsx` (×3), plus the separately-shaped `sectionHeadingClass` in `channel-members/styles.ts`, all re-derive the "dim uppercase section/field label" look `SectionLabel.tsx` already ships in two sanctioned sizes — and none of the five match either sanctioned size exactly (`0.16em` tracking vs `SectionLabel`'s `0.18em`/`0.2em`).
4. **6 field-error call sites → one shape.** Only 2 of 6 (`CreateChannelDialog`, `ChannelSettingsDialog`) use `fieldErrorAria`/`fieldErrorProps`; `SecretCaptureDialog` has `role="alert"` with no aria wiring, `OversizePasteDialog` has neither, and `DocumentStreamDialog` uses the wrong colour token (`--danger` instead of `--danger-text`) on top of missing `role="alert"` — a single `renderFieldError`-style helper used everywhere would fix all four gaps at once.
5. **1 bespoke search input + 2 competing dense-input classes → one `Input` component with a `size` prop.** `MemberManagementPopup.tsx`'s search box (§10) shares none of `.admin-input`'s tokens; separately, `.admin-input-sm` (1 caller) and `.admin-input-compact` (13 callers) are two answers to "dense input" with no documented boundary, and produced one inert-utility bug (`TodoInstanceCard.tsx`'s stacked `text-xs`) exactly the kind a `size` prop would make impossible.
