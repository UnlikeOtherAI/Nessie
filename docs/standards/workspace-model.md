# The workspace model: organisation, workspace, project

This is the one authoritative statement of what an organisation, a workspace, a
project and a channel are, and which of them the SSO owns. Everything else —
`README.md`, `CLAUDE.md`, `AGENTS.md`, the brief — points here rather than
restating it, because restating it is how the four of them drifted apart.

## The model

UnlikeOtherAI (UOA), the SSO, owns two levels and the people in them:

```text
UOA Organisation
  └── UOA Team ── many Users (and a user belongs to many teams)
```

Nessie mirrors those, one for one, and adds its own constructs inside them:

```text
Nessie Organisation          ← one UOA Organisation
  └── Workspace              ← one UOA Team
        ├── Project          ← Nessie only. UOA has no such concept.
        │     └── Channel
        └── (agents, knowledge, boards, …)
```

Three facts follow, and every one of them is load-bearing:

1. **A workspace IS a UOA team.** Not a copy of one, not a container for one —
   the same thing, named differently. `Team.externalWorkspaceId` is the binding.
   The product says *workspace*; the SSO says *team*.
2. **A project is a construct within Nessie.** UOA has never heard of it. It is
   a body of work — boards, tasks, plans, approvals, knowledge — living inside
   one workspace.
3. **A project belongs to exactly one workspace.** "Which workspace does this
   project belong to?" must always have exactly one answer. A project shared
   between workspaces, or belonging to none, is not a state this product has.

## Vocabulary

| Concept | UOA calls it | We call it, everywhere |
|---|---|---|
| The tenant | Organisation | **organisation** |
| The group of people you work in | Team | **workspace** |
| A body of work inside a workspace | — | **project** |
| A room inside a project | — | **channel** |

Never say "team" to a person for the thing UOA calls a team — that word is the
SSO's, and using it in the product is what makes a workspace and a project look
like the same kind of object. The local Prisma model is still named `Team` for
migration reasons; that is an implementation detail, not permission to surface
the word.

## What the schema does today, and why it is wrong

**The foreign key is currently inverted.** `Team.projectId` makes a Project the
*parent* of a Team, so the schema reads Organisation → Project → Workspace —
the opposite of the model above.

That single inversion is the cause of several defects that look unrelated:

- `createWorkspaceEnvironment` must fabricate a Project for every UOA workspace,
  because a Team cannot exist without a Project parent. The phantom project is
  forced by the FK, not chosen.
- That fabricated project is named after the workspace, so one upstream name
  lands on two rows and both need healing from UOA.
- `CreateProjectDialog` does the mirror image: it asks for a project name and
  silently creates a `"{Name} Team"` alongside it.
- `Team.projectId` has no unique constraint, so several workspaces can hang off
  one project — a state the model above says cannot exist.

**The fix is to invert the relationship**, not to constrain it: a project
carries the workspace it belongs to (`Project.teamId`), rather than a workspace
carrying its project. Adding a unique constraint to the current direction would
freeze the wrong shape permanently. The migration touches `Channel` (which
carries `organizationId`, `projectId` and `teamId` today), `ProjectMember`, and
everything project-scoped; it is specified in
[docs/plans/2026-09-02-uoa-as-a-service-unification.md](../plans/2026-09-02-uoa-as-a-service-unification.md).

Until that lands, treat the FK direction as a known defect rather than as the
model. Code and copy should be written for the model above.

## What Nessie must not store

UOA owns identity and the organisation/team hierarchy, so Nessie keeps no
second copy of it: no local authority over an organisation's or workspace's
name, no local roster that can disagree with UOA's, no second copy of who is in
which team. The binding keys (`Organization.externalOrgId`,
`Team.externalWorkspaceId`, `User.uoaSub`) are not duplication — they are what
makes asking UOA possible. The full rule is in `AGENTS.md` → "UOA owns the org
structure"; the outstanding gaps are in the plan linked above.
