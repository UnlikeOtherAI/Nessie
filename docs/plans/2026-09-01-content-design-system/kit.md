# The content kit — reference

Status: **built** (2026-09-01). This is what a content page is made of. The
audit that produced it is in `overview.md`; the per-area evidence is in
`audit/`.

Scope: the body of a page. **Not** navigation, page headers (`ScreenHeader`,
which composes `ResponsivePageHeader`, plus `PageHeaderMenu`), `TabBar`,
button styling (`.admin-button*`), or any chat surface. A control that
already lives in a page header stays there. The header is the navigation
framework's — [docs/navigation/overview.md](../../navigation/overview.md) §9.

## The seven rules

1. **Reuse; never fork.** If a component is one prop short, add the prop to
   the component.
2. **No nesting.** A card never contains a card, a table never contains a
   table, a bordered box never sits inside a bordered box. Depth is dividers
   and spacing. `Card` throws in development if you nest it; `RowList`,
   `KeyValueList` and `StatTile` drop their own frame inside a `Card`
   automatically, so composing them is always safe.
3. **Tokens only.** No hex, no Tailwind named colours (`emerald-600`,
   `bg-white`, `bg-black/40`), no `style={{ color: 'var(--x)' }}`. One
   spelling: `text-[color:var(--tx3)]`. Prose uses the `-text` tone token
   (`--danger-text`), never the fill token (`--danger`).
4. **Every fetch has three states.** Loading, error *with Retry*, empty — and
   they must be distinguishable. A failed fetch that renders as an empty list
   is a bug, and there were nine of them.
5. **Every mutation has a visible failure.** `role="alert"`, on the field when
   the server named one.
6. **Every irreversible action confirms**, through `ConfirmDialog`.
7. **One contract from the API to the pixel.** A list pages, sorts and reports
   errors the one way; a route that does it differently is refactored, not
   accommodated.

## Layout

| Import | Use |
|---|---|
| `shared/PageBody` — `PageBody` | The scrolling body under a page header. `width`: `narrow` (form column), `regular` (default), `wide` (tables, grids). Left-aligned, `p-5`, `gap-6`. A board, canvas or column browser does **not** use it — those are fixed-height regions that scroll inside themselves and need an unbroken `flex h-full min-h-0` chain, so they keep their own shell. |
| `shared/PageBody` — `Section` | A titled block **with no frame**: heading, optional description, optional `actions`. This is the default grouping — do not wrap a section in a `Card` to give it a heading. |
| `shared/Card` — `Card` | Something that reads as one object. `variant`: `section` (p-4) or `row` (p-3). `tone="attention"` for a block awaiting the reader. |
| `shared/SidePanel` | A panel beside the content. Not a dialog; it does not trap focus. |

## Lists and tables

| Import | Use |
|---|---|
| `shared/DataTable` — `DataTable` | Genuinely tabular data. Column definitions carry `header`, `align`, `width`, `render`, `sortable`, `secondary` (hidden below `sm`). Handles skeletons (`loading`, `skeletonRows`) and `empty`. Owns its frame; never place it in a `Card`. |
| `shared/RowList` — `RowList`, `Row` | A list of records that is not tabular. `Row` takes `leading`, `title`, `subtitle`, `trailing`, `selected`, `depth`, and `href` **or** `onClick` — a row that does nothing renders as a plain row, not a button. |
| `shared/SectionOverflowHint` | "…and 12 more" closing a deliberately capped summary list. Not pagination. |

**Sorting is a server round-trip.** `onSortChange` reports intent; the caller
re-queries. Never re-sort the page the browser is holding.

## Pagination — the one contract

Server (`api/src/services/audit.ts` `listAuditLogs` is the reference):

```ts
import { buildPage, decodeKeysetCursor, resolvePageLimit } from '@nessie/schemas'

const limit = resolvePageLimit(query.limit)
const total = await prisma.thing.count({ where })   // before the cursor clause
const parsed = decodeKeysetCursor(query.cursor)
// …add the keyset clause to `where` when `parsed`…
const rows = await prisma.thing.findMany({ where, orderBy, take: limit + 1 })
const page = buildPage({ hasCursor: Boolean(parsed), limit, rows, total })
return { data: page.data.map(toRecord), meta: page.meta }
```

- Cursors are opaque keyset cursors. Offset paging is retired.
- `total` is required on admin lists — it is what makes "26–50 of 134"
  possible. Omit it only where counting is meaningless (ranked search).
- Page size defaults to 25 and is capped at 100. Every paged admin list uses
  the same **Items per page** picker: 10, 25, 50 or 100. Its chosen value lives
  in the URL with the cursor, and changing it returns to page one.

Client:

```tsx
const list = usePagedList<ThingRecord>({
  path: '/api/things', queryKey: thingKeys.list(), params: { q, status },
})

<PaginationFooter
  canNext={list.canNext} canPrevious={list.canPrevious}
  label={list.label} onPageChange={list.onPageChange}
  onPageSizeChange={list.onPageSizeChange} page={list.page}
  pageCount={list.pageCount} pageSize={list.pageSize}
/>
```

The cursor lives in the URL, so paging survives reload and Back. Call
`usePagedListReset()` when a filter changes. `PaginationFooter` always shows
the result range and **Page X of Y** beside Previous/Next; its page count comes
from the required `total`, not from whichever slice the browser currently has.

## Forms

| Import | Use |
|---|---|
| `shared/FormField` — `FormField` | Wraps every control: `label`, `help`, `error`, `required`. Generates the id and wires `aria-invalid` / `aria-describedby` through context. |
| `shared/FormControls` — `Input`, `Select`, `Textarea` | `size`: `default` or `compact`; `mono`. Never hand-roll `.admin-input`. |
| `primitives/Switch` | One thing on or off. |
| `primitives/Checkbox` | Several things out of many. |
| `shared/ChoiceGroup` | Pick exactly one in a form, inside a `fieldset`/`legend`. Its compact `inline` variant renders the shared sliding `TabBar` in `radiogroup` mode; its explanatory `card` variant stays native radios. |
| `shared/FormActions` — `FormActions` | The action row: right-aligned, primary rightmost, Cancel to its left only when there is an edit to discard. `destructive` pins a record-level delete to the left edge. |
| `shared/FormActions` — `FormError`, `FormSuccess` | Whole-form outcome. Both render nothing when empty, so write them unconditionally and the failure path cannot be forgotten. |
| `facades/form-errors` — `toFormErrors` | Maps a rejected request onto `{ fieldErrors, formError }`. |

Help text is a line under the field, never a placeholder — a placeholder
vanishes exactly when it is needed.

## States, chips, detail

| Import | Use |
|---|---|
| `shared/QueryState` | Loading / error+Retry / empty for a fetch. Adopt it. |
| `shared/EmptyState` | "Nothing here yet", with optional `title` and `action`. Never for an error. |
| `primitives/Skeleton` — `Skeleton`, `SkeletonRows` | Only where the layout is already known (a table, a card grid). Otherwise `QueryState`'s line. |
| `primitives/Pill` | Every status chip. Tones: `accent`, `danger`, `info`, `muted`, `outline`, `success`, `warning`. `height="control"` to line up in a column. |
| `primitives/Notice` | A banner after an action. Tones add `info` and `neutral`. `role="alert"` for a failure, `role="status"` for a success. |
| `shared/KeyValueList` | Named facts about a record. A real `<dl>`. `layout`: `rows` or `grid`. |
| `shared/StatTile`, `StatGrid` | A number read at a glance. `tone` colours the value, never the box. |
| `shared/CopyField` | A value meant to be copied, not read. |
| `shared/ListToolbar` | Search, filters and the count above a list. |

**One tone map per domain.** Put `status → PillTone` in that feature's
`*-presentation.ts` and import it; nine independent copies of that mapping
existed. `agents/todos/todo-presentation.ts` is the model.

## Scale

- **Radius**: card 12px (`.admin-card`), dialog panel 14px, chip `rounded` or
  capsule. Nothing else.
- **Padding**: card section `p-4`, card row `p-3`, list row `px-3 py-2.5`,
  page body `p-5`.
- **Type**: section title `text-sm font-semibold`; label `SectionLabel` /
  `FieldLabel`; body `text-sm --tx2`; meta `text-xs --tx3`; stat value
  `text-2xl font-semibold`. `text-[10px]`/`text-[11px]` only inside `Pill` and
  `SectionLabel size="2xs"`.
- **Tracking**: only `SectionLabel`'s three sizes — `xs` 0.2em, `2xs` 0.18em,
  `sm` 0.16em.
- **Borders**: `--sep`. `--border-strong` only on a focused or hovered control.

## Verifying a migration

`pnpm exec tsc --noEmit -p admin/tsconfig.json`, `pnpm exec eslint <files>
--max-warnings 0`, and `pnpm --filter @nessie/admin test`. A UI change is not
done until it has been screenshotted with headless Playwright against
`http://localhost:5455` — see `AGENTS.md` → Verification.
