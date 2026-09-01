# Governance slice — content design-system audit

Files covered:
- `admin/src/pages/AuditLogPage.tsx` (94 lines)
- `admin/src/pages/ApprovalsPage.tsx` (214 lines)
- `admin/src/pages/PolicyPage.tsx` (183 lines)
- `admin/src/pages/AlertsPage.tsx` (89 lines)
- `admin/src/pages/FeedbackPage.tsx` (27 lines)
- `admin/src/pages/feedback/FeedbackComposer.tsx` (144 lines)
- `admin/src/pages/feedback/FeedbackList.tsx` (139 lines)
- `admin/src/pages/UnreadMessagesPage.tsx` (78 lines)
- `admin/src/pages/ThreadsPage.tsx` (73 lines)
- `admin/src/pages/channels/ThreadInboxCard.tsx` (276 lines) — card chrome only; `ChannelMessageFeed`/`ChannelComposer` internals are out of scope (chat)
- `admin/src/pages/thread-inbox-filter.ts` (37 lines) — pure localStorage hook, no rendering
- `admin/src/components/shared/AlertRow.tsx` (115 lines)

One-level import follow-through checked: `settings/settings-shared.tsx` (`SettingsPanel`, used by `FeedbackPage`), `Pill`, `SectionLabel`, `PaginationFooter`, `QueryState`, `EmptyState` (baseline primitives), `components/features/workflows/presentation.tsx` (`formatRelativeTime`, imported by `UnreadMessagesPage`/`ThreadsPage`).

---

## 1. Body containers & sections

Every page in this slice is the same outer shell, hand-rolled six times rather than shared:
```
<section className="flex h-full min-h-0 flex-col">
  <AdminPageHeader .../>
  <div className="min-h-0 flex-1 overflow-y-auto p-4"> …
```
`AuditLogPage.tsx:46-49`, `ApprovalsPage.tsx:63-66`, `PolicyPage.tsx:85-88`, `AlertsPage.tsx:53-56`, `ThreadsPage.tsx:34-36` all use `p-4`. `UnreadMessagesPage.tsx:21-23` drops the padding entirely (rows are full-bleed `px-5 py-4`). `FeedbackPage.tsx:12` instead goes through `SettingsPanel` (`settings-shared.tsx:53-58`), whose body padding is `p-5`, one step up from the other five pages' `p-4` — a single-page divergence with no stated reason.

Inside the body, list items are wrapped in `admin-card` at varying padding: `p-3` (`AuditLogPage.tsx:60`, `ApprovalsPage.tsx:169`, `PolicyPage.tsx:144`, `AlertsPage.tsx:71`) vs `p-4` (`ApprovalsPage.tsx:80` for the *pending* card only — same page, two densities for "pending" vs "history" rows). `PolicyPage.tsx:89` uses `admin-card` for the create-rule form too (`p-4`), so `admin-card` is doing triple duty as list-row, form-panel and card-list-item container with no distinct treatment.

`ThreadInboxCard.tsx:92-98` does not use `admin-card` at all — it hand-rolls a bordered `<article>`:
```
'overflow-hidden rounded-xl border bg-[color:var(--surface)] shadow-sm'
```
with `border-[color:var(--border-strong)]` (or `border-l-4 border-l-[color:var(--accent)]` when unread) — a different surface token (`--surface` vs whatever backs `admin-card`) and a different radius (`rounded-xl` vs `admin-card`'s own). This is the richest container in the slice (header row + feed + composer) and it is the one that does not reuse the shared card class.

`FeedbackPage.tsx:13-19` is also the only page using a `@container` query with `@min-[900px]:grid-cols-[...]` — a bespoke responsive column split nothing else in the slice does (everyone else is single-column `grid gap-*`).

**Verdict: two-variants** (page shell padding `p-4` vs `p-5`; card padding `p-3` vs `p-4` with no rule) plus **one outlier** (`ThreadInboxCard`'s bespoke `<article>`). Missing primitive: a `PageBody`/`ListShell` wrapper for the `section > header > overflow-y-auto p-?` shape, and a decision on card-row padding (`p-3` for dense list rows, `p-4` reserved for forms/detail).

## 2. Tables & data lists

No `<table>`, `.admin-table`, `.agents-table` or `ExpandableTable` anywhere in this slice — every list is a `div.grid.gap-2` of `admin-card` rows (audit entries, policy rules, approvals) or a `<ul>` of bordered `<li>` (`FeedbackList.tsx:73-104`) or full-width row-buttons (`UnreadMessagesPage.tsx:39-73`, `ThreadsPage.tsx:44-57`). These are all "card lists," category 2's other named shape.

Row internals differ per file even though the informational shape (title + status chip + timestamp + secondary line) repeats four times:
- `AuditLogPage.tsx:60-79`: `flex justify-between` header row (mono action + `Pill`, timestamp) + one `mt-1 text-xs` detail line.
- `PolicyPage.tsx:144-169`: same header shape plus a bare-text `Delete` action (`text-xs text-[color:var(--danger-text)] hover:text-[color:var(--danger)]`, `PolicyPage.tsx:162-168`) instead of a real button/icon-action column — the only row-level destructive action in the slice, and it is a plain link-styled `<button>`, not a `.admin-button` variant.
- `ApprovalsPage.tsx:80-155` (pending) and `169-202` (resolved): same header shape again, but pending rows add a reason line + conditional "Open page/Open to-dos" button + an Approve/Reject action row (`ApprovalsPage.tsx:133-154`) that only this file has.
- `FeedbackList.tsx:75-102`: a `<li>` with `border border-[color:var(--sep)] bg-[color:var(--panel)] p-3` instead of `admin-card` — visually similar but a hand-rolled equivalent of the card class rather than a reuse of it.

`UnreadMessagesPage.tsx:39-73` and `ThreadsPage.tsx` (via `ThreadInboxCard.tsx:100-137`) both render "inbox row with icon-avatar + title + relative time + unread badge," but as two different DOM shapes: `UnreadMessagesPage` is one clickable `<button>` per row inside a `divide-y` list; `ThreadInboxCard` is a full expandable card with its own header bar, not a row in a list at all. No sorting/selection/sticky-header affordances anywhere (none of these lists need them, but note it for completeness — n/a).

No zebra striping anywhere; borders are `divide-y divide-[color:var(--sep)]` (`UnreadMessagesPage.tsx:39`) vs per-item `admin-card` border vs per-item hand-rolled border (`FeedbackList`) vs no border at all between rows (`AuditLogPage`, `ApprovalsPage`, `PolicyPage`, `AlertsPage` rely on `grid gap-2` spacing, not dividers).

**Verdict: many-variants.** No shared "list row" primitive exists; every page reinvents the title/chip/timestamp/detail-line row. Missing primitive: a `ListRow` (or "record row") component parameterizing title, tone chip, timestamp, secondary line, and an optional trailing action — would resolve Audit Log, Policy, Approvals-history and Feedback-list at once.

## 3. Pagination & loading more

Three different mechanisms, none of them `PaginationFooter`:
- `AuditLogPage.tsx` / `PolicyPage.tsx` / `AlertsPage.tsx`: no pagination UI at all — just a hard `limit` param (`limit=50`/`limit=100`/`limit: 100`) with no way to see more.
- `ThreadsPage.tsx:58-69`: hand-rolled "Load more" button, centered, using bare `admin-button-secondary` (missing the `admin-button` base class — see §11 for other consequences) with a `Loading threads…`/`Load more threads` label swap.
- `FeedbackList.tsx:110-134`: fully hand-rolled Previous/Next strip, explicitly *not* `PaginationFooter` by the file's own comment (`FeedbackList.tsx:106-109`): label-first-then-buttons-grouped-right at `text-sm`, vs `PaginationFooter`'s edges-with-centered-label at `text-xs`. This is a real, code-documented divergence, not an oversight.

**Verdict: many-variants.** Missing primitive is already built (`PaginationFooter`) and simply unused in this whole slice — zero call sites. `FeedbackList`'s custom strip is the closest candidate to converge into it (page/totalPages arithmetic already matches the footer's `page`/`canPrevious`/`canNext` contract almost exactly).

## 4. Forms

Two real forms in this slice, and they diverge on nearly every axis:

**PolicyPage.tsx:89-140** (`Create Rule`): four inline `admin-input` controls in a `grid grid-cols-4 gap-2` row with **no `<label>` elements at all** — the selects/input are identified only by their placeholder/option text (`PolicyPage.tsx:92-131`). Submit button is `justify-self-start` (left-aligned) at the form's own bottom.

**FeedbackComposer.tsx:73-141**: real `<label>` wrapping each control (`<label className="mt-4 block"><span className="text-xs text-[color:var(--tx3)]">Title</span><input .../></label>`, lines 79-89 and 91-100), i.e. label-above-control via a `<span>` rather than a semantic label-text element, no `<label htmlFor>`/`id` pairing (implicit wrapping instead). Submit button is `justify-end` (right-aligned) — the opposite placement from `PolicyPage`. Includes non-form-field elements that categories 4/5/6 all touch: file attach (button+hidden input), inline preview, remove link, and its own inline error line (`FeedbackComposer.tsx:135`, see §5).

No fieldset/grouping anywhere; no required-marker convention (`PolicyPage`'s fields are all effectively required by being selects with defaults, `FeedbackComposer` enforces required-ness only via a computed `canSubmit` boolean, never surfaced visually). No autosave — both are explicit-submit. Disabled/pending state is `disabled={<mutation>.isPending}` in both, consistent.

**Verdict: two-variants** (labeled-above vs unlabeled grid; left- vs right-aligned submit). Missing primitive: a `FormField` (label + control + optional help/error) and a settled submit-row placement convention — `FormFieldError` (§5 baseline) already exists but neither form uses it.

## 5. Validation & field errors

`FormFieldError` (the named baseline helper) is used **nowhere in this slice**.

- `PolicyPage.tsx`: no validation/error surface at all — a failed `createRule`/`deleteRule` mutation is silently swallowed (no `isError` branch read anywhere in the file).
- `FeedbackComposer.tsx:135`: a form-level (not per-field) error line, bare `<div className="mt-3 text-sm text-[color:var(--danger-text)]">{error}</div>` with no `role="alert"`, no `aria-invalid`/`aria-describedby` wiring to the fields above it.
- `AlertRow.tsx:108-112`: a different form-adjacent error line, this one **does** carry `role="alert"`: `<span className="w-full text-xs text-[color:var(--danger-text)]" role="alert">{acceptError}</span>`. Same semantic purpose (report a failed mutation next to its trigger button) as `FeedbackComposer`'s error line, different element (`span` vs `div`), different size (`text-xs` vs `text-sm`), and only one of the two has `role="alert"`.

No keystroke-time validation anywhere (both forms are submit-time / mutation-outcome only).

**Verdict: two-variants**, and neither reuses the shared `FormFieldError` primitive despite it existing for exactly this. Worth flagging as the sharpest miss in this slice: the baseline (`FormFieldError.tsx`) is unused by every governance page that has a form.

## 6. Feedback after actions

No toast, no `Notice`/`FeedbackBanner` use in this slice (both exist as baseline but are only reached via `settings-shared.tsx`, and `FeedbackPage.tsx` itself never renders `FeedbackBanner` — it just re-lists on submit success). Feedback is:
- Transient inline text swap on the triggering button itself: `{busy ? 'Sending…' : 'Send feedback'}` (`FeedbackComposer.tsx:139`), `{markRead.isPending ? 'Marking read…' : 'Mark read'}` (`ThreadInboxCard.tsx:126`), `{accepting ? 'Accepting…' : 'Accept'}` (`AlertRow.tsx:105`), `{activity.isFetchingNextPage ? 'Loading threads…' : 'Load more threads'}` (`ThreadsPage.tsx:66`) — a consistent micro-pattern (label swap during `isPending`), but never a post-success confirmation ("Saved") anywhere; success is implied only by the list re-rendering.
- Persistent error-as-feedback (§5's error lines) is the only "after action" state that outlives the action itself.

**Verdict: consistent-but-minimal / n/a for banners in this slice** — no hand-rolled banners to converge, but also zero reuse of `Notice`/`FeedbackBanner` where a real success/failure banner would help (e.g. Policy rule create/delete has no confirmation of either).

## 7. Loading / error / empty states

Zero uses of `QueryState` in this slice, despite four different hand-rolled versions of exactly its triad existing side by side:

- `ThreadsPage.tsx:37-43`: three separate conditionals, textually close to `QueryState`'s contract —
  `<div className="py-8 text-center text-[color:var(--tx3)]">Loading threads…</div>`,
  `<div className="py-8 text-center text-[color:var(--danger-text)]">Threads could not be loaded. Try again.</div>` (**no Retry button** — just prose telling the user to retry, unlike `QueryState`'s clickable Retry),
  and empty line reusing the same `py-8 text-center text-[color:var(--tx3)]` class.
- `UnreadMessagesPage.tsx:24-38`: the same three-state shape, same `py-8 text-center` loading/error lines (byte-identical tone tokens to `ThreadsPage`), but its **empty** state is a different, richer treatment — a dashed bordered card (`rounded-lg border border-dashed border-[color:var(--sep)] bg-[color:var(--panel)] px-5 py-4 text-center font-semibold`, lines 33-36) centered in the remaining viewport height, which is much closer to the shared `EmptyState` component's look (dashed border) than to its own sibling pages' plain centered text.
- `AuditLogPage.tsx:84-88`, `PolicyPage.tsx:173-177`, `ApprovalsPage.tsx:204-208`, `AlertsPage.tsx:80-84`: all four use the identical bare line `<div className="py-8 text-center text-[color:var(--tx3)]">…</div>` for empty-only (none of these four render a loading or error state at all — `AuditLogPage.tsx:81-83` and `PolicyPage.tsx:171-172` both carry a code comment explicitly noting "Not QueryState… this page renders no loading and no error state at all"). This is the majority pattern in the slice (4 of 9 files) and is trivially `QueryState`-shaped already.
- `ThreadInboxCard.tsx:139-149`: a third loading treatment — animated skeleton bars (`h-10 animate-pulse rounded bg-[color:var(--surface-hover)]`, `h-16 animate-pulse …`) instead of a text line, plus its own error line (`text-sm text-[color:var(--danger-text)]`, no Retry, just "Open it to try again" prose) — this is the one legitimate "different question" case `QueryState`'s own doc-comment carves out (skeleton, not a line).
- `FeedbackList.tsx:65-70`: a fourth loading/empty pair, `text-sm text-[color:var(--tx2)]` (not `tx3`) left-aligned under the section label rather than centered — file's own comment notes this is deliberate because it takes a plain `isLoading` boolean, not a query with `refetch`.

**Verdict: many-variants.** This is the single biggest, most mechanical win in the slice: `AuditLogPage`, `PolicyPage`, `ApprovalsPage`, `AlertsPage` need only the empty-line half of `QueryState` (no query object needed since they don't branch on loading/error today, but the pattern is identical padding/tone), while `ThreadsPage`/`UnreadMessagesPage` are genuine `QueryState` drop-ins (`isLoading`/`isError` + `refetch` already on their query objects) that would additionally *gain* a Retry button they currently lack.

## 8. Status chips & badges

`Pill` (the shared baseline) is used correctly in three files: `AuditLogPage.tsx:66-68` (outcome success/danger), `ApprovalsPage.tsx:183-195` (status success/danger/muted), `PolicyPage.tsx:147-149` (effect allow/danger) — all `radius="chip" size="sm"`, consistent.

Two hand-rolled chip-shaped elements sit outside `Pill`:
- `UnreadMessagesPage.tsx:69-71`: an unread-count badge, `rounded-full bg-[color:var(--accent)] px-2 py-0.5 text-xs font-semibold text-[color:var(--on-accent)]` — a capsule pill in every visual respect but built by hand rather than via `<Pill tone="accent" radius="capsule">`.
- `AlertRow.tsx:100-106`: the invitation "Accept" affordance, `rounded-md bg-[color:var(--accent)] px-2 py-1 text-xs font-semibold text-[color:var(--on-accent)]` — this one is arguably a button, not a chip (it's `onClick`), so it's more of a §12/button-placement note, but it shares the exact same fill/text token pair as the badge above, so the two hand-rolled elements are visually a matched, un-consolidated pair.
- `FeedbackList.tsx:18-27`: a bespoke `StatusChip` sub-component that is **not chip-shaped at all** — no background, no radius, no padding, just colored bold text (`text-xs font-semibold ${tone}`) with a 3-way status→color map (`failed`→`--danger-text`, `submitted`→`--accent`, default `saved`→`--tx3`) done locally rather than via `Pill`'s tone map. This is the slice's clearest local tone-mapping reinvention named directly by category 8.
- `ApprovalsPage.tsx:68-70`: yet another tone-as-text pattern, a "N pending" line styled as `text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--warning-text)]` — hand-assembles exactly the `uppercase`+`tracking-[0.16em]`+`font-semibold` combination `Pill`'s own `casingClasses` doc-comment says it centralizes, but as a plain span, not a `Pill`.

**Verdict: two-variants** (real `Pill` usage vs. three independent hand-rolled tone-color patterns: accent capsule badge, bare colored-text status word, warning-tracked label). `Pill` itself is a good, already-used baseline here; `FeedbackList`'s `StatusChip` is the worst offender in this category since it duplicates the tone-mapping *concept* with a different visual result (text-only vs filled chip) for the same kind of data (item status).

## 9. Detail / key-value views

No `<dl>` or two-column metadata grid anywhere in this slice — every page is list-only, no drill-down detail view. The closest analog is the single detail line under each row's title (`AuditLogPage.tsx:74-78`: `{actorType}:{actorId} → {resourceType}:{resourceId}`; `PolicyPage.tsx:157-160`: `{scope}:{scopeId} → {bindings...}`), both using the same `&rarr;` arrow-separated inline format and same `mt-1 text-xs text-[color:var(--tx2)]` styling — this pair is actually **consistent** with each other, just not a real key/value view.

**Verdict: n/a in this slice** (no detail pages exist to compare structurally), with a note that the two inline "from → to" summary lines (`AuditLogPage`, `PolicyPage`) are a small, already-consistent micro-pattern worth keeping if a shared "record summary line" primitive is ever built for category 2.

## 10. In-content filters, search boxes & toolbars

- `AuditLogPage.tsx:50-57`: a single `admin-input` text filter, wrapped in `<div className="mb-4 w-full max-w-xs">` — free text, no debounce visible, no count summary.
- `AlertsPage.tsx:25-40`, `ThreadsPage.tsx:23-31`: filters are pushed into `AdminPageHeader`'s `headerActions` (a `PageHeaderAction[]` toggle — "Unread only") rather than an in-body filter row. This is explicitly out-of-scope per the brief (`AdminPageHeader`/page-title action rows are excluded), but worth noting as the reason categories 10's "filter row above the list" pattern barely appears in-body in this slice — two of the three filterable pages moved the control into the header instead of the content area, while `AuditLogPage` kept its filter in-body. That inconsistency (header-toolbar vs in-body filter, for the same *kind* of control — a binary/text filter above a list) is itself a content-boundary finding even though the header component itself is out of scope.
- No count summaries ("34 items") anywhere in the slice; `AlertsPage.tsx:28` folds a count into the toggle's own label instead (`Unread only (3)`), a different placement than a standalone summary line.
- `ThreadInboxCard.tsx:230-238`: an "Also send to #channel" checkbox sits in the content body just above the composer — a content-embedded settings toggle, not a filter, but the only raw `<input type="checkbox">` in the slice (`accent-[var(--accent)]`) rather than the shared `Switch` primitive.

**Verdict: two-variants** (in-body text filter vs. header-toolbar toggle for structurally the same job), **n/a for count summaries** (none present).

## 11. Typography & spacing inside content

Muted-text token usage is fairly disciplined: `--tx3` for timestamps/secondary/empty-state text (used in all nine page files), `--tx2` for body/description text (`ApprovalsPage.tsx:104`, `PolicyPage.tsx:157`, `AlertRow.tsx` unread-false rows, `ThreadInboxCard.tsx:230` checkbox label), `--tx` for primary text. No stray `--tx3` where `--tx2` should be or vice versa was found.

Padding scale in play across the slice: `p-3`, `p-4`, `p-5` all appear as **body-level** paddings with no documented rule for which applies where (see §1) — `p-3` for dense card rows, `p-4` for the page body and for "richer" cards (Approvals pending, Policy create-form), `p-5` for `SettingsPanel`'s body and for `FeedbackList`/`FeedbackComposer`'s own card padding and for `UnreadMessagesPage`'s row `px-5 py-4`. Border radius: `rounded-lg` (`UnreadMessagesPage.tsx:34` empty card, `FeedbackList.tsx:77` item), `rounded-md` (`FeedbackComposer.tsx:116` image preview, `AlertRow.tsx:100` accept button), `rounded-xl` (`ThreadInboxCard.tsx:94`, `EmptyState.tsx:10` baseline), `rounded-full` (unread dots, avatar badges, accept-count badge) — four radii in active use with no visible size-to-radius rule (a `p-3` row uses `admin-card`'s own radius implicitly; hand-rolled elements pick radius per-file).

Border tokens: `--sep` is the near-universal divider/border token in this slice (`AuditLogPage`, `FeedbackComposer.tsx:116`, `FeedbackList.tsx:77`, `UnreadMessagesPage.tsx:34,39`, `ThreadInboxCard.tsx:100,185,201`). `--border-strong` appears once, only in `ThreadInboxCard.tsx:96-97` for its hand-rolled article border — the one file not using `admin-card`, so it also reaches for the one border token none of its siblings use.

One real markup-hygiene bug worth flagging: `ThreadsPage.tsx:61` — `className="admin-button-secondary"` (missing the base `admin-button` class every other secondary button in this slice includes, e.g. `FeedbackList.tsx:117,125`, `ApprovalsPage.tsx:110,145`, `FeedbackComposer.tsx:104`). Since button *styling* is out of scope, flagging only the missing base-class composition, not the color.

Two independent relative-time formatters exist and are both used inside this slice's files: `AlertRow.tsx:3-26` (local `formatRelativeTime`, format `"2h ago"` / `"just now"` / falls back to `toLocaleDateString()`) vs. `components/features/workflows/presentation.tsx:11-29` (imported into `UnreadMessagesPage.tsx:5,62` and `ThreadsPage.tsx` transitively via nothing — actually only `UnreadMessagesPage` imports it directly; re-checked: `ThreadsPage.tsx` does not use it, only `UnreadMessagesPage.tsx:4,62` does). The two formatters diverge in wording: `AlertRow`'s never says "in" (past-only), `presentation.tsx`'s handles future time too (`"in 2 h"`) and abbreviates unit differently (`"2 h"` vs `"2h"`, space vs no space). Same underlying need (relative timestamp on a list row), two independently-written implementations, one imported from a chat-feature file into a governance page.

**Verdict: many-variants** for padding/radius scale specifically; **two-variants** for the relative-time formatter duplication. No raw hex/named Tailwind colors found anywhere in this slice (checked via grep across all twelve files) — clean on that specific defect.

## 12. Destructive & confirm flows with forms in dialogs

No `Dialog`/`ConfirmDialog` usage anywhere in this slice, and no dialogs at all. The two destructive-ish actions present are handled without a dialog:
- `PolicyPage.tsx:162-168`: rule "Delete" is a single-click bare-text button (`text-xs text-[color:var(--danger-text)] hover:text-[color:var(--danger)]`) with **no confirmation step** — immediate `deleteRule.mutate(rule.id)` on click.
- `ApprovalsPage.tsx:133-154`: Approve/Reject are also single-click, no confirmation, though arguably lower-stakes since approvals are reversible-by-history and already gated by being an explicit review action.

**Verdict: n/a in this slice** for dialog-based confirm flows (none exist), but worth flagging that `PolicyPage`'s irreversible rule deletion has no confirmation at all where `ConfirmDialog` exists precisely for this shape (`AGENTS.md`'s own note that `ConfirmDialog` replaced four native `window.confirm` deletes — this is a fifth call site never converted, having apparently never had *any* confirmation).

---

## Good model / worst offender

- **Good model:** `AuditLogPage.tsx` and `PolicyPage.tsx` are the cleanest, most literal card-list pattern in the slice (header row: mono id + `Pill` + timestamp, detail line below) — smallest, most consistent, and both self-document their deliberate non-use of `QueryState` rather than silently drifting.
- **Worst offender:** `FeedbackList.tsx` — inside one 139-line file it hand-rolls a `<li>` that duplicates `admin-card`'s look without using it (§1/§2), a `StatusChip` that reinvents `Pill`'s tone-mapping as bare colored text instead of a chip (§8), a bespoke Previous/Next strip explicitly declared non-`PaginationFooter` (§3), and its own bespoke loading/empty text sizing (§7) — four of the twelve categories' variants are all demonstrated in this single file.

## Top 5 unification wins for this slice

1. **Loading/error/empty triad → `QueryState`.** 4 files (`AuditLogPage`, `PolicyPage`, `ApprovalsPage`, `AlertsPage`) already hand-spell the empty-only half; 2 more (`ThreadsPage`, `UnreadMessagesPage`) have full `isLoading`/`isError`/`refetch`-shaped queries hand-spelled with **no Retry button**, which `QueryState` would add for free. 6 files, one component.
2. **List-row card shape → a shared `ListRow`.** The title+`Pill`+timestamp+detail-line row is written out four times with matching intent and slightly different DOM (`AuditLogPage`, `PolicyPage`, `ApprovalsPage`×2 densities, `FeedbackList`'s `<li>` variant) — one parameterized row component would absorb all of them.
3. **Status/tone chips → `Pill` everywhere.** 4 hand-rolled tone-color elements (`UnreadMessagesPage`'s unread-count badge, `AlertRow`'s Accept button fill, `FeedbackList`'s `StatusChip`, `ApprovalsPage`'s "N pending" label) duplicate `Pill`'s tone system outside it; `FeedbackList.StatusChip` is the highest-value fix since it's a genuine status→color mapping, not just visual coincidence.
4. **Form fields → `FormFieldError` + a `FormField` label wrapper.** `PolicyPage`'s create-rule form has no labels and no error surface at all; `FeedbackComposer`'s form has ad-hoc `<label><span>…</span><input/></label>` labels and a bare unstyled-per-spec error div with no `role="alert"`. The shared `FormFieldError` baseline is unused by both.
5. **Pagination → `PaginationFooter`.** Zero call sites across this whole slice despite two hand-rolled alternatives (`ThreadsPage`'s "Load more" button, `FeedbackList`'s custom Previous/Next strip, the latter explicitly documented as deliberately-not-`PaginationFooter`) — a real candidate to fold both into the shared footer, or to formally extend it with a "Load more" mode if that shape needs to stay distinct.

Secondary/smaller wins worth the synthesizer's attention: consolidate the two relative-time formatters (`AlertRow.tsx` local vs. `components/features/workflows/presentation.tsx`), settle body-padding scale (`p-4` vs `p-5` at the page-shell level; `p-3` vs `p-4` at the card-row level), and add a confirmation step to `PolicyPage`'s rule-delete action.
