# Disclosure boundaries — what an agent read decides who may read its answer

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md)
so it is read when the work touches this area rather than loaded into every
session. `AGENTS.md` carries the one-line invariant and points here; **this
file is the rule**.

- **A read that enters a run's context feeds the disclosure sink, in the same
  change.** An agent reaches material its audience cannot, and what stops it
  laundering that into a shared room is provenance: `ConsumedSourceSink`
  (`worker/src/run/execute/disclosure-basis.ts`) collects the scoped sources a run
  consumed, `computeReplyBasis` subtracts what the destination already implies,
  and the remainder is stamped on the message and the run by the one write
  chokepoint (`agent-message.ts`). **An empty basis means unrestricted**, so a
  read path that forgets to feed the sink does not fail loudly — it publishes to
  everyone. That is the whole defect class, and it is why the obligation sits on
  the *read*, not on the reply. Adding a tool that puts content in the window and
  not adding its scope is the same defect as skipping the `FileService`.
  Corollaries, each learned from a real gap: resolve a source's scope with the
  shared `scopeForVisibility` rather than a second mapping beside your reader,
  since a thought's `(audience_type, audience_id)` and a knowledge space's
  `visibility` + chain are one fact in two shapes; record a channel scope only
  when the channel is **not public**, because viewer channel scopes come from
  `ChannelMember` rows alone and stamping a public channel withholds the reply
  from people entitled to read the source; and make search **fail closed**
  (exclude anything carrying a basis) rather than withhold, because a snippet
  list has nowhere to render a placeholder. On the read side every path asks the
  one predicate — list, single message, and the durable thought log alike, since
  reasoning inherits the provenance of what the reply was built from. The live
  SSE lanes cannot filter per viewer, so they are cut structurally by
  `runReplyIsRestricted` the moment a run consumes a privileged source; that
  predicate is monotone by construction, which is what makes it safe to call per
  delta. Containment (`constrainScopesToDestination`) is a floor under all of
  this, but it constrains **memory recall only** — never treat it as "nothing
  crosses". Details: `CLAUDE.md` → "Disclosure boundaries"; spec and build status:
  `docs/plans/2026-08-11-disclosure-boundaries-build.md`.

## Detail

Moved verbatim out of [`CLAUDE.md`](../../CLAUDE.md) → "Disclosure boundaries — what an agent read decides who may read its answer".


Provenance, not redaction: every read that enters a run's context feeds the
`ConsumedSourceSink` in the same change. The rule and its corollaries (empty
basis fails open, shared `scopeForVisibility`, channel scopes only for
non-public channels, search fails closed, every read path asks one predicate,
live lanes cut by `runReplyIsRestricted`, containment = memory recall only): stated above.
Facts not restated there:

- The remainder after `computeReplyBasis` is stamped as `MessageBasisScope` +
  `RunBasisScope` in the same transaction as the message; `agent-message.ts`
  opens that transaction itself rather than trusting callers.
- Basis vocabulary is `user | channel | team | project | organization | agent`.
  `agent:<id>` means exactly the people who pass the shared live agent-visibility
  predicate. A destination implies agents bound to its channel; those ids are
  loaded once into the run context so `runReplyIsRestricted` stays synchronous
  on every streamed delta. Tool-posted messages resolve the bindings of their
  own target channel instead.
- Sink writers today: the transcript window (transitive), memory recall, every
  knowledge-base read, the conversation searches, attachment reads, and an
  admitted checkpoint — and a checkpoint on resume is a read path too.
- Protected mail is additionally a content boundary for model-visible reasoning:
  each main inference holds provider reasoning in memory until its tool calls
  are known. An inference with protected mail context or a protected mail tool
  call writes and streams only a server-authored withheld marker, never a model
  summary of correspondence. Utility transcripts and checkpoint prompts use
  the same protected-tool registry, so they withhold lifecycle and mailbox
  operations as well as message reads and sends.
- A withheld row carries no metadata, reactions, or reply participants; the
  share affordance goes only to a reader who satisfies the basis directly,
  never a grant recipient. The WS/SSE terminal events carry `restricted: true`
  instead of a preview.
- Spec and build status:
  [docs/plans/2026-08-11-disclosure-boundaries-build.md](../plans/2026-08-11-disclosure-boundaries-build.md).
