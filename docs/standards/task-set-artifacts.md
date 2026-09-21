# Task-set file sources and output artifacts

`@nessie/knowledge` owns deterministic source parsing and artifact writing.
The task-set core owns ingestion checkpoints, item uniqueness, immutable
results, execution and output receipts. Neither adapter invokes an LLM.

## Source contract

A source pins a Documents page and exact version; its current attachment is
never substituted. `resolveTaskSetDocumentSource` checks the current home or
share entitlement and the pinned version's disclosure basis. Ingestion calls
that resolver initially and at every page of at most 200 admitted records;
dispatch must repeat the live check when consuming an already imported item.
The adapter returns classified version/home provenance with each item, and
`consumeTaskSetDisclosure` registers it into a consuming run's source sink.
Ingestion alone does not register a later processor's read.

Items retain the original one-based source ordinal. An identity includes the
page/version, worksheet/table/record path and ordinal. An optional business
key is retained in the locator but never collapses duplicate source rows.
Restart reopens the same version and skips admitted ordinals. The core must
verify identity and input hash when replaying an ingestion page and close
the input only when parsing finishes successfully.

- CSV/TSV use an explicit optional `headerRow`; without it rows are arrays.
  Quoted line breaks count as part of one record. Empty rows are retained.
- XLSX requires a worksheet name. It reads existing cached formula values
  alongside their formula text; an unevaluated/error formula is refused.
  It does not execute formulas, macros or external connections.
- SQLite requires an ordinary table in a consistent uploaded snapshot.
  Views, virtual/generated columns and ambiguous ordering are refused.
  Primary keys define order, with an available rowid as a tie-breaker for
  rowid tables. Integer values are decimal strings, preserving 64-bit values;
  BLOB values retain a base64 encoding marker. Runtime requires Node 22.13+
  for its built-in `node:sqlite`; extensions and writes are disabled.
- JSON arrays stream their entries; a single root value is one item. A nested
  array/value needs an explicit `recordPath`. JSONL gives one value per line;
  malformed/empty records stop ingestion with their locator.
- Field mappings preserve nested JSON. A string selects a literal top-level
  name; strings beginning `/` use JSON Pointer (`/company/name`). A numeric
  selector is a one-based column/array position. Nothing guesses flattening.

The byte limit is 256 MiB per source, also applied to declared expanded XLSX
ZIP content. Selected records are at most 1 MiB with nesting depth at most 64;
tabular records have at most 512 columns. These parser admission limits are
not model-context guarantees. Overflow refuses the input without truncation.
XLSX caches its shared-string/style tables but streams worksheet rows; SQLite
uses a read-only disposable disk copy. Scratch files live in the OS temporary
directory and are removed on ordinary completion/failure, never inside a
checkout. Durable bytes remain exclusively in Documents/FileService.

## Output contract

Results remain in the core ledger. `finalizeTaskSetArtifact` consumes a paged
async iterator and creates a new file in the chosen Documents folder: plain
text, JSONL, or XLSX. XLSX includes sequence, item ID, the complete selected
source input as JSON, raw result text and explicitly mapped result fields.
Mapped results must be valid JSON; large cells fail with a JSONL remedy.
Text resembling an Excel formula is written as text, never an executable
formula object. The original source workbook is untouched.

Each result must carry classified disclosure; the writer unions that basis
and private-source lineage into the new document version. The caller
revalidates current destination authority throughout rendering and before
byte/page persistence. A receiver agent is not needed.

The stable output operation key derives one internal page UUID. FileService
stores the rendered stream, then the core persists the returned attachment
receipt before page creation. A retry reuses that receipt, and a completed
page is recovered by the same UUID after a crash before acknowledgement.
Moved, edited or deleted outputs produce a conflict rather than a second
visible file. The core must fence simultaneous finalizers and retain the
receipt in durable state. An abrupt process death between FileService store
and receipt persistence can leave an unlinked blob; it cannot create a
duplicate visible document. Normal destination/storage failures preserve
completed item results for retry.

The parser/output tests include synthetic 80,000-record JSONL restart and
80,000-row XLSX iteration, SQLite ordering and rejection, disclosure refusal,
formula-safe output and replay after receipt persistence. These exercise
deterministic file handling, not 80,000 model calls or measured Ollama speed.
