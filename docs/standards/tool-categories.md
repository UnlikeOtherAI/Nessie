# A tool declares where it belongs; no surface guesses

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **A tool declares where it belongs; no surface guesses.**
  `BuiltinToolDefinition.category` is **required** and its vocabulary is
  `TOOL_CATEGORIES` in `@nessie/schemas` — one ordered list of
  `{id, label, description}` that every surface listing tools renders in order.
  The admin used to infer a category from the tool's id prefix (`file_`,
  `web_`, `kb_`…) and sweep everything unmatched into one "Agent & team"
  bucket; that bucket had grown to hold **75 of 116** builtins, because a new
  tool joined it by default and the only way out was to invent another prefix
  rule. Making the field required means adding a tool without choosing a home
  does not compile, and `packages/runtime/test/builtin-tool-categories.test.ts`
  additionally refuses any category holding more than a quarter of the
  catalogue — crossing that means the category has stopped describing anything
  and needs splitting, not that the ceiling needs raising. A category is a
  place a person would go looking ("where do I turn off email?"), never an
  implementation detail. The category is resolved onto `ToolDescriptor` from
  the definitions at the API boundary, beside `requiresExplicitGrant` and for
  the same reason — it is a property of the tool's code, so re-categorising one
  must never need a migration. The picker renders **every section closed**: 116
  tools across sixteen categories is an index, not a page of switches, and
  searching expands only the sections that still match without disturbing the
  ones a person opened. One component draws that list in both modes
  (`ToolPicker`, `readOnly` for a viewer who cannot change a tool); the
  separate read-only renderer that used to exist had drifted to its own
  grouping, its own cards and no search at all.
- **`spreadsheets` is its own category, not a corner of `knowledge`.**
  The twelve `sheet_*` builtins (`sheet_describe`, `sheet_read_range`,
  `sheet_find`, `sheet_replace`, `sheet_write_range`, `sheet_format_range`,
  `sheet_structure`, `sheet_filter`, `sheet_tabs`, `sheet_create`,
  `sheet_export`, `sheet_versions`) and their `nessie_sheet_*` MCP mirrors
  declare `category: 'spreadsheets'`. `knowledge` already held 13 ids, and
  adding twelve more would have put it over the quarter-of-the-catalogue cap
  the test enforces — but the cap is the symptom, not the reason. A person
  choosing tools asks "can it work in spreadsheets?" as one question, and the
  answer should be one switchable group rather than twelve entries scattered
  through the documents list. The category is deliberately **not** in
  `EFFECTFUL_TOOL_CATEGORY_IDS`: a spreadsheet is the organisation's own
  document, a duplicate edit is visible to the agent on its next read and
  reversible through `sheet_versions restore`, and these are high-frequency
  writes where a ledger row per call would be paid where it buys least.
