# Board-source destination

## Decision requested

Approve a board destination for each connected source. Today `BoardSource`
belongs only to a project and every newly mirrored task has `Task.boardId =
null`, which means the project's default board. A Linear team or Jira project
cannot therefore feed a separately named Nessie board.

## Proposed model

Add nullable `BoardSource.boardId` with a foreign key to `Board` using
`onDelete: SetNull`, plus an index. `null` retains the current default-board
behaviour. `Task.boardId` already uses the same deleted-board rule, so deleting
a board returns both its tasks and its sources to the default board.

`BoardSource` remains unique by `(projectId, provider, containerKey)`: one
external container is connected once to a project, with one chosen destination.

## Behaviour

Source creation accepts an optional board in the enclosing project. New mirrored
tasks receive that source destination. Ordinary sync does not overwrite an
existing task's board, preserving a person's manual card move. An explicit
source-destination change transactionally updates the source and rehomes all
tasks currently linked to that source; this is the only bulk board move.

The source record and create/update bodies expose `boardId`. The API validates
that a supplied board belongs to the source project. The source picker defaults
to the board from which a person begins the connection flow, or the default
board when no board is named.

## Delivery boundary

This needs a new immutable Prisma migration, schema/API contracts,
`@nessie/team-admin` source creation and explicit rehome logic, worker sync and
webhook apply contexts, source tests, and the Sources UI picker. No migration
or runtime change has started pending approval.
