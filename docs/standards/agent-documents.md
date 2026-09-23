# Agent documents — required core, one shared home

Authoritative standard, routed from [`AGENTS.md`](../../AGENTS.md). Read this
before changing agent creation, cloning, run admission, knowledge access, the
Documents Finder, or any editor/tool that can mutate an agent-owned space.

## The durable shape

Every ordinary root agent owns one private `<Agent> — Documents` Knowledge
space. `packages/knowledge/src/provisioning.ts` is the only home provisioner.
Knowledge rows require a project-shaped storage envelope, but that envelope is
not the home's audience: the resolver keeps an existing home's project, then
prefers the agent's creation project, then the organisation's invisible
shared-channel root. The oldest live project is only a pre-root legacy/test
fallback. It never uses the caller's ambient project. A spawned child uses its
parent's home; it never receives a second copy. The Personal Assistant and
other system-managed agents are code-owned and do not get an organisation-wide
personal notebook.

An ordinary agent's active core is exactly two top-level Markdown file pages:

| Durable role | Canonical filename | Meaning |
| --- | --- | --- |
| `identity` | `AGENTS.md` | identity, purpose and durable operating instructions |
| `working_rules` | `personality.md` | voice, temperament and working style |

The typed `AgentCoreDocument` mapping is the authority; a name alone never
turns a page into an instruction. The canonical names are nevertheless an
invariant so the files are legible to people and tools. Core files inherit the
home's project, visibility and sensitivity, remain at its top level, and cannot
be archived, moved, renamed, rescoped, or replaced with a non-Markdown file.
Content edits append an immutable file version through `FileService`; broad
notebook write access is never enough to edit core instructions. The same
`assertAgentFieldAuthority` decision used by the Agent Designer governs every
core writer.

Creation, clone, the human Documents route, the Knowledge root repair pass and
run admission all enter the same idempotent `ensureCanonicalAgentCore` seam.
It creates the complete pair in one database transaction; there is no blank or
one-file cutover. Staged bytes are removed when the transaction loses a race or
fails. The former marker-zero legacy state is resumable through the same seam.
Authorship is truthful: human creation/editing records `user`; run-time repair
records the acting `agent`. Existing mapped pages, versions and run snapshots
keep their IDs when their historical filenames are migrated.

An authorized person may edit and publish a core Markdown revision through the
shared Knowledge surface or the Agent Designer. An agent tool may read those
files but cannot revise, restore or publish them, even in its own home.
The complete files remain stored when they exceed the configured core budget;
the surface reports the estimate and a new or resumed run refuses with an
actionable request to shorten them. Mandatory instructions are never silently
truncated.

System-managed agents keep their blueprint instructions in code. Their
Documents tab projects a read-only `AGENTS.md` and `personality.md`; it must not
materialise an editable home or turn a blueprint into tenant-owned state.

## What reaches a model

Run admission pins the exact published versions of both required files in
`RunCoreDocumentSnapshot`. Before opening either attachment, it validates the
complete pair, re-resolves live space and version-source entitlement, and adds
their audience and disclosure lineage to `ConsumedSourceSink`. A resumed run
reauthorizes the pinned versions and tombstones again. A later publication can
affect a new run only; it never changes an admitted run in place.

The runtime system prompt is assembled in this order:

1. Nessie's platform/security instructions;
2. the acting agent's `AGENTS.md` snapshot;
3. its `personality.md` snapshot;
4. current conversation and task context.

A delegated child also keeps its immutable server-authored assignment. It
inherits the exact parent-run core snapshot, not whichever versions happen to
be current when the child wakes. Blueprint agents use the same prompt shape
from their read-only code projection.

Core is eager; every other accessible document is on demand. `kb_list`,
`kb_search`, and `kb_page_read` are safe built-ins enabled by default for
ordinary agent runs unless an administrator deliberately disables/restricts
them. The prompt supplies the real home id whenever that read set is present.
`kb_page_read` pins a `versionId`, returns bounded text plus `nextOffset`, and
requires both for continuation so one read cannot mix revisions. A stored file
without extracted text returns an actionable instruction to use a file-specific
tool or publish a text-readable version. Write tools are optional and are
described only when the resolved run actually has them.

Every read—eager core, Designer `agent_read`, search, list or page read—applies
the intersection of live home entitlement and the exact version's retained
source basis. Authorization and provenance stamping happen before bytes are
opened. Empty basis means no additional restriction; missing/unknown private
lineage fails closed. Seeing an agent is not permission to edit it, and a
session's ambient project is never an entitlement filter.

## Human surfaces and navigation

The owning surfaces are the agent's Documents tab and the shared Knowledge
Finder. The Knowledge root contains one **Agents** doorway, never one row per
agent. Opening it produces the agent directory; opening an agent produces that
agent's existing Documents home, preserving route ancestry:

`Knowledge → Agents → <agent> → folder/file`

Back unwinds that chain one level at a time on a phone, while split layouts keep
the same columns inline. Cold deep links and prewarm use the same routes. The
Finder, Tree sidebar and Move/Copy destination picker consume the same root
payload; agent homes may be destinations but are never duplicated among normal
spaces. Existing uploads, folder trees, document previews and history reuse the
shared Knowledge components rather than an agent-only browser.

A folder remains a page of kind `folder`. `ensureTaskFolder` creates one and
finds it again by `(kind: 'folder', metadata.taskId)`; it has no version, is
never published and is never indexed. No writer or reader may revive the
retired `metadata.folder` flag or infer folder-ness merely from having
children.

Specs and forward learning work:
[agent documents](../plans/2026-08-31-agent-documents.md) and
[agent documents and learning](../plans/2026-09-08-agent-documents-and-learning.md).
