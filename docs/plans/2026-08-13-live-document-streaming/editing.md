# Live document streaming — delta editing and viewport behaviour

This chapter continues the numbered design in [the overview](./overview.md).

## 7. Delta editing + edit-following viewport (shipped 2026-08-14)

Composing a document was only half of it: asking for a change to an existing
document should not regenerate the whole thing, and the person should be able to
watch the change land where it belongs.

**`kb_document_edit`** takes `pageId` + `edits: [{find, replace}]`. Only the
changed passages are generated. `find` must match the current document exactly
once — anything else is refused in words rather than guessed at, and the live
preview skips an anchor it cannot place so a viewer never sees a change that
will not be saved. An empty `replace` deletes.

**Anchor before text.** An edit is published (`stream.document.edit
{editIndex, offset, removeLength}`) the moment its `find` value closes, before
any replacement text exists. That ordering is the whole reason the viewport can
move to the change site and wait there instead of revealing after the fact
where the change happened. Models emit arguments in schema order, so `find`
naturally arrives first.

**Positions, not appends.** `stream.document.delta.offset` is now the absolute
insertion point in the composed document, and the client applies deltas in
`seq` order — offsets stop being monotonic once edits land mid-document, so
offset-based dedup would be wrong. Composing a new document is the degenerate
case: one edit at offset 0 removing nothing, then increasing offsets.

**Durable lane switches to snapshot mode for edits.** A log of appends cannot
represent a change in the middle of a document. Bootstrap concatenates chunks
in id order either way, so one replaced snapshot row reads back correctly with
no API change. The base document is written to that lane *before*
`stream.document.start` is published, so a client bootstrapping on the event
sees the document rather than an empty page.

**Two implementations, deliberately.** The streaming tracker
(`document-stream-edit.ts` `createDocumentEditTracker`) and the save
(`applyDocumentEdits`) apply the edits independently, and the save asserts they
produced the same document. Collapsing them would turn a real check into a
restatement.

### Edit-following viewport

The change cursor stays vertically centred in the popup while text is being
written, with two rules that come straight from how it should feel:

- **Clamped, never padded.** The scroll target is clamped to
  `[0, scrollHeight - clientHeight]`. Near the end of a document the clamp
  naturally stops centring and the text simply grows upward — which is what
  "no white space at the bottom" means. Spacer elements to force centring are
  forbidden.
- **Stable, not twitchy.** A deadzone suppresses sub-threshold corrections so
  continuous writing does not jitter the page; a new `stream.document.edit`
  (a deliberate jump the user wants to see) re-engages following and animates.
  Manual scrolling releases the follow, with an affordance to re-engage.

### Leaving mid-write

While a session is `streaming`/`saving` the admin registers a `beforeunload`
guard, and closing the dialog asks first. The confirmation offers honest
choices, because hiding is *not* destructive: **Keep writing** (minimise to the
chip, generation continues), **Stop and discard** (cancels the run — nothing is
saved, the established behaviour), **Cancel**. The guard is removed the moment
no session is active, so it can never block ordinary navigation.

In-app navigation away from the channel asks the same question through the data
router's `useBlocker` (`admin/src/hooks/useLeaveGuard.ts`), which is the
router's own seam — no click or history interception. Only a change of path
blocks; the same screen re-filtering itself does not. The wording differs from
the close case because the consequence does: leaving the page does not stop the
run either, so the choices are **Leave — it keeps writing**, **Stop and
discard**, and **Stay here**. The guard lives with the session list rather than
with the popup, because the question is whether anything is still being written
in this thread — minimised chips included — not whether the popup is open.

### Two integration bugs the end-to-end verification caught

Both were invisible to unit tests on either side, because each half was correct
against the contract as written and the contract was underspecified.

1. **An edit session opened on an empty page.** The client created its entry
   from `stream.document.start` and waited for deltas — but an edit's offsets
   are relative to a document that already exists, which the client had never
   fetched. `stream.document.start` now carries `mode: 'compose' | 'edit'`, and
   an `edit` triggers the bootstrap read immediately. A compose session still
   fetches nothing.
2. **A snapshot bootstrap double-applied buffered frames.** The durable lane
   keeps appends for a composed document but a whole *snapshot* for an edited
   one, and a snapshot silently contains every delta published before it was
   read. Replaying the frames buffered during the fetch wrote that text twice.
   `mergeBootstrap` now takes a `snapshot` flag: it adopts the snapshot, drops
   the buffer, and asks for one more read. The lane flushes every 250 ms, so it
   converges immediately and nothing is applied twice in between.

`admin/test/document-edit-replay.test.ts` exists so neither can come back: it
emits the exact event sequence the worker produces and asserts the client's
helpers land on the worker's document — for a single edit, several edits whose
offsets depend on each other, shrinking edits, deletions, single-character
provider chunks, and the snapshot-bootstrap case.
