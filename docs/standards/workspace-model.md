# The workspace model: organisation, workspace, project

Authoritative standard for what an organisation, a workspace, a project and a
channel are, and which of them the SSO owns. `AGENTS.md` carries the one-line
invariant and points here; **this file is the rule**. It exists because four
documents each restated the hierarchy in their own words and all four ended up
with it backwards, as `Organisation → Project → Team → Channel`.

**The schema currently contradicts this document** (§"What the schema does
today"). Write code and copy for the model below, not for the foreign key.

## The model

UnlikeOtherAI (UOA), the SSO, owns two levels, and people are members of the
lower one:

```text
UOA Organisation
  └── UOA Team        (people are members; one person is in many teams)
```

Nessie mirrors both, one for one, and adds its own constructs inside them:

```text
Organisation      = UOA organisation     the tenant
  Workspace       = UOA team             a person is in many
    Project       (no UOA counterpart)   a body of work, in exactly one workspace
      Channel     (no UOA counterpart)   a room in a project
      boards, knowledge, tasks, approvals — project-scoped
    agents — workspace-scoped
```

Read the right column as *is the same thing as*, not *is derived from*: a
workspace does not mirror a UOA team, it **is** one.

Three facts, each load-bearing:

1. **A workspace IS a UOA team.** Not a copy of one, not a container for one —
   the same thing, named differently. The product says *workspace*; the SSO says
   *team*.
2. **A project is a construct within Nessie.** UOA has never heard of it. It is
   a body of work — boards, tasks, plans, approvals, knowledge — living inside
   one workspace.
3. **A project belongs to exactly one workspace.** "Which workspace does this
   project belong to?" must always have exactly one answer.

### Reading guide: the names are crossed

This is the part that trips everyone, so read it once and it will stop biting:

- In **Nessie's** schema and routes, `Team`, `teamId`, `TeamMember` all mean
  **workspace**. The local Prisma model still wears the SSO's word.
- On the **UOA wire**, `teamId`, `teamRole` and `/org/organisations/:orgId/teams`
  are the same object under UOA's own word.
- `Team.externalWorkspaceId` is where the two words meet — the local column
  wears *our* word and holds *their* id, which is the exact reverse of the model
  name it sits on.
- Older docs and comments say "UOA workspace". That means UOA team. Same thing.

**The exceptions**, which are Team and Project rows that are not user
workspaces or user projects, and which fact 3's absolute does not cover: the
`channelRoot` Project that holds organisation-wide channels, and
`systemManaged` Teams (the Personal Assistant and external-agent surfaces).

## Vocabulary

| Concept | UOA calls it | We call it, everywhere |
|---|---|---|
| The tenant | Organisation | **organisation** |
| The group of people you work in | Team | **workspace** |
| A body of work inside a workspace | — | **project** |
| A room inside a project | — | **channel** |

Do not say "team" to a person for the thing UOA calls a team. The reason is not
tidiness: two words for one group of people is how two rows came to carry one
name. `CreateProjectDialog` asks for a project name and silently creates a
`"{Name} Team"` beside it, and the workspace switcher labels rows
`team.teamName ?? project.projectName` — so whichever row was written first is
what a person sees, and renaming the other one changes nothing.

**The admin does not fully obey this yet.** Roughly two dozen strings still say
"team" — the budget scope picker offers "Team" and "Workspace" as *sibling*
scopes, agent ownership says "Team-owned", `CreateSpaceDialog` says "Everyone on
your team". Those are the copy equivalent of `Team.projectId`: known, wrong, and
scheduled with the vocabulary pass in the plan below. Do not add more; do not
take an existing one as licence.

## What the schema does today, and why it is wrong

**Write for the model above, not for the foreign key.** Concretely, that means:
name new identifiers and all copy *workspace* and *project*; add no new
dependency on `Team.projectId`; add no feature or constraint that assumes a
project can hold several workspaces; and treat "which workspace is this project
in" as a question with one answer even where the join could currently return
several. Existing queries still have to traverse the FK as it is — that is
expected, and does not make the current direction the model.

**The foreign key is inverted.** `Team.projectId` makes a Project the *parent*
of a Team, so the schema reads Organisation → Project → Workspace — the opposite
of the model above.

**What the inversion actually causes**, kept separate from what merely travels
with it — the tidy version of this list said one foreign key explained all four,
and two of them have their own causes:

- **Caused by the FK.** `createWorkspaceEnvironment` must fabricate a Project
  for every UOA workspace, because `Team.projectId` is non-nullable and a Team
  cannot commit without a Project to hang from. The phantom project is forced,
  not chosen. (`Channel.projectId` is non-nullable too, so a channel compels one
  independently.)
- **Half caused by the FK.** That fabricated project *exists* because of the FK,
  but it *shares the workspace's name* because `createWorkspaceEnvironment`
  computes one `name` and hands it to both rows. The duplicate that
  `syncExternalWorkspaceNames` then has to heal twice is that convention, not
  the FK.

Two more defects are commonly filed with these and do **not** follow from the
direction, though inverting it happens to resolve both:

- `CreateProjectDialog` asking for a project name and silently creating a
  `"{Name} Team"` is caused by there being **no way to create a project inside
  an existing workspace** — `createTeamForUser` requires a `projectId`, so the
  dialog manufactures a team to hold the project. Under the inverted schema it
  would have to manufacture a workspace instead. The shape of the creation API
  is the bug.
- Several workspaces hanging off one project is a **missing `@unique` on
  `Team.projectId`**, not a direction problem. Adding that constraint would fix
  it while leaving the direction wrong — which is precisely why the fix below is
  the inversion and not the constraint.

**The fix is to invert the relationship**, not to constrain it: a project
carries the workspace it belongs to (`Project.teamId`), rather than a workspace
carrying its project. Adding a unique constraint to the current direction would
freeze the wrong shape permanently. The migration touches `Channel` (which
carries `organizationId`, `projectId` and `teamId` today, with nothing
forbidding an inconsistent triple), `ProjectMember`, and everything
project-scoped; it is scoped — not yet fully specified — in
[docs/plans/2026-09-02-uoa-as-a-service-unification.md](../plans/2026-09-02-uoa-as-a-service-unification.md),
and `scripts/inspect-workspace-shape.sql` sizes it against real data.

## What Nessie must not store

UOA owns identity and the organisation/team hierarchy, so Nessie keeps no second
copy of it: no local authority over an organisation's or workspace's name and
no second authority over who is in which team. That is the target, not a
description of today — `OrganizationMember`, `TeamMember` and `ProjectMember`
all still exist and are re-projected from UOA's claims rather than derived live,
and profile and workspace names are still mirrored locally. The binding keys (`Organization.externalOrgId`,
`Team.externalWorkspaceId`, `User.uoaSub`) are not duplication — they are what
makes asking UOA possible. That rule, and the outstanding gaps against it, are
in the plan linked above.
