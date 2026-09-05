# Agent documents — one shared home provisioner

Authoritative standard, moved verbatim out of [`AGENTS.md`](../../AGENTS.md) so
it is read when the work touches knowledge-space provisioning rather than
loaded into every session. `AGENTS.md` → "Architecture" carries the one-line
summary and points here; **this file is the rule.**

Knowledge-space provisioning lives in `@nessie/knowledge`:
`packages/knowledge/src/provisioning.ts` owns `ensureMyDocsSpace`,
`ensureProjectDocumentsSpace`, `ensureTaskFolder`, and the advisory-locked
`ensureAgentDocsSpace`; `api/src/services/knowledge-provisioning.ts` is only a
thin re-export for established API callers. At inference-run setup, a
non-system agent with an assembled KB write tool lazily gets its private
`<Agent> — Documents` home (or reuses it); a spawned child uses its parent's
home, and the Personal Assistant has none because its documents belong in the
person's My Docs. When `kb_list`, `kb_search`, `kb_document_compose`, and
`kb_document_edit` are all actually available, the structural system-prompt
block injects that home id and title so the model never invents a `spaceId`.

Spec: [docs/plans/2026-08-31-agent-documents.md](../plans/2026-08-31-agent-documents.md).
