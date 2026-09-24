# Setting it up: the Designer, the screens, and an agent that sets up flows

Rule zero: none of this is done until a person can reach it. There are two
ways in, and both must work end to end:

- **Talk to the Agent Designer**, in one conversation, for example: *"Build a
  CTO for Nessie. It picks up tickets moved to In progress, keeps Claude
  informed when they change, reviews spec edits in Tech docs, and uses my PC
  and my Mac."*
- **Click through** the Triggers editor, the board and the machine page.

The Designer can do nothing the screens cannot, and the reverse holds too.

## What the Designer needs (T1 and T4)

- **`project_structure_read(projectId)`**, a read-only Designer tool. It
  returns the project's boards with their columns and categories, the channels
  the requester can read (with visibility, and whether the agent is bound),
  and the document spaces with their top-level folders. Without it the
  Designer guesses board, column and folder ids.
- **Typed trigger configs**, derived from the `@nessie/schemas` union (see
  [triggers.md](triggers.md#configuration)). Columns can be given by name or
  category, refusals are field-level, and the resolved targets come back as
  links.
- **Executor facts** gain `pairedByYou` and `codingSessionsReviewed`, and
  the Designer holds `executor_standing_policy_prepare`. Its answer is the
  composite card, which lands in the author's own DM. The Designer runs there
  anyway.
- **Catalogue text** is generated. It includes:
  - a trigger section built from the typed config schemas;
  - a ticket-work facts section: a wake follows when a coding turn ends, so
    end your turn after start or send; `check_back_in` and its bounds; the
    per-ticket limits; ticket comments reach the project audience;
  - a correction of the stale line that says board tools work only "on a
    person's turn".
- **The persona's setup order**: create the agent, then bind it to a
  project channel every member can read, then the trigger, then one
  machine-access card. Its neutral example instructions have Claude wait for
  CI **inside its turn** and merge on green: *"Open the PR, run `gh pr checks
  --watch`, fix and push until green, merge, then end your turn with the PR
  URL and merge state."* With that, most tickets finish on a turn-end wake.
- **The proposal card** gains "Starts work when" and "Runs on" rows. It
  also says that one confirmation follows for the machines. The
  agent-proposal-card suite pins both.
- **Channel rule unchanged:** an agent gets no channel of its own on
  creation. The Designer binds it to an existing project channel, or creates
  one only when the person asks.

## Screens (Rule zero doorways)

| Where | What | PR |
|---|---|---|
| Triggers editor | The `ticket_changed` and `document_changed` types. Board, column and document pickers; pickup, follow and endOn; assign on pickup; quiet wake; limits; sectioned instructions | T1, T2 |
| Trigger detail | A **Machine access** section. Its state (not set up, awaiting confirmation, live, suspended with a reason, ended by whom), "Set up machine access…", which prepares and confirms in place, and End. It also shows the queue and the last wakes with reasons, from delivery rows | T4 |
| Board column header | The read-only badge *"Moving here starts work: CTO"*. The column menu offers "Start work with an agent…" to people who can create triggers; it opens the editor prefilled | T1 |
| Ticket dialog | The work chip, the thread link, the reminder with Cancel, and `work_*` activity rows | T1, T3 |
| Board card | The agent's avatar with a state dot | T1 |
| Work thread | Wake rows; a composer that is read-only for people who cannot edit the board; the Tickets fold in the channel's conversation list | T1 |
| Finder and project docs | "Tell an agent when this changes…" on a folder or page, for people who can create triggers. A row badge *"Reviewed by CTO · v5 · thread"* | T2 |
| Executor page | A **Standing access** panel in the ExecutorLeasesPanel pattern: policy, trigger, author, state, End. The coding-sessions rows link the ticket key and say *"ticket work under Ondrej's standing access"* | T4 |
| Board settings, Watchers | Agent recipients removed, with the line *"Agents start work from the column menu"* | T1 |

The owner-only Triggers routes stay owner-only. Everything a mover needs is
on the ticket instead ([ticket-work.md](ticket-work.md#what-the-project-sees)).

## The project-operator capability (T6)

Ondrej asked that the CTO itself can set up new projects and flows. An agent
can do this only **for the live person talking to it**, never on an unattended
run. It never gains standing authority of its own.

- **One explicit-grant capability**, `project_operator`, in the tool-policy
  registry. An owner grants it from the agent's Tools page, or the Designer
  grants it with `agent_tool_access_set`. It is admitted by a third arm at
  `tool-policy.ts` (beside the PA and identity arms) only when the run:
  - is a shared agent's run, with a user actor, `interactive: true` and no
    peer-delegation or channel-policy purpose;
  - has `effectiveUserId` absent or equal to the actor;
  - is bound to a project channel.

  The handlers re-check each condition. `ticket.work`, trigger and scheduled
  runs never get it.
- **The verbs** act as the live requester through `resolveActingMember` and
  the route services. They change nothing a person could not change in the
  UI:
  - `project_create` and `project_list`;
  - `channel_create` (protected by default);
  - `ticket_board_create`, plus new `ticket_board_column_create` and
    `ticket_board_column_update`;
  - `ticket_label_create`;
  - new `kb_space_create`;
  - `agent_trigger_create` and `agent_trigger_update`, for itself or for
    agents bound in that project's channels.

  Project membership changes are **not** in the set: they would grow who can
  start work.
- **Workflow tools move behind it.** `workflow_create`, `_update`,
  `_install`, `_trigger_create` and `_run` currently carry no flags, so any
  shared agent can install workflows and arm webhook, event or cron workflow
  triggers as the speaking owner. T6 flags them with the same arm. It
  migrates every agent whose tool policy lists them explicitly into an
  explicit grant, and the migration summary names each one. Workflow triggers
  record their creator.
- **Machine access stays the author's.** A trigger the CTO creates shows
  *"Machine access: not set up"*. The requester gets an attention item, *"Set
  up machine access for <trigger>"*, which opens the trigger's Machine access
  section. The CTO says so in its answer.

### As built (T6)

The capability shipped as above; the standard is
[personal-assistant-tools.md](../../standards/personal-assistant-tools.md) →
"The project-operator capability". Where the code led somewhere else, the
intent was kept and the difference is recorded here:

- **`project_operator` is a registry entry, not a tool.** It is one of
  `CAPABILITY_GRANT_DEFINITIONS`: registered, protected and shown on the Tools
  page like any explicit-grant builtin, and offered to no model.
- **"No peer-delegation or channel-policy purpose" became "no purpose at
  all".** A person's own turn carries none, and every other kickoff
  (`ticket.work`, peer delegation, channel policy, briefs, deliveries) carries
  one, so an allow-list refuses the next one too.
- **`team_create` is in the set** (organisation owners only, as the route),
  because standing a project up can need its team and the verification list
  names a non-owner's refusal.
- **`ticket_board_create` and `ticket_label_create` may name another project**
  the person can change, so a board and labels can be set up in a project the
  agent just created. Their lend keeps the channel's project.
- **`kb_space_create`** takes `kind: "project_documents"` (the idempotent
  Project Documents provisioning) or `kind: "space"` with a name — a
  project-visible space such as "Tech docs". A folder inside a space is left to
  the knowledge tools.
- **Triggers stay in the run's project.** `agent_trigger_create` and
  `agent_trigger_update` on the operator arm act for the agent itself or an
  agent bound in one of the run's project's channels, and their target channel
  must be in that project. Binding an agent into a channel the person just
  created is not in the set, so a trigger in a new project is set up from a
  conversation in that project once the agent is placed there.
- **`workflow_list`, `workflow_preview` and `workflow_run_status` stay
  ordinary tools**: a list of names an owner may read, a pointer card each
  viewer's own access renders, and a status-only read.
- **Workflow triggers record their creator** as `config.authorUserId`, like
  agent triggers; the fire is unchanged and runs with no person attached.
- **"A live requester" means the person's own turn**, not just a user actor on
  an interactive run: the message the run answers (and every message a drain
  folded in) is their own composer message, and a Continue, a card or approval
  resume or a Restart was their own press. Restart and Continue swap in the
  presser and replay the original input, a card resumes as the parked actor
  whoever answered, and a drain takes its latest person's actor, so without it
  somebody else's input could open the verbs. The arm also stays shut in an
  organisation-wide channel.
- **The workflow writes and the new verbs need a live turn on every arm**, the
  Personal Assistant's included, whose arm otherwise opens on its schedules.
- **`project_structure_read` is in the set**, and `project_create` and
  `ticket_board_create` answer with their board's columns by id, so the
  operator shapes the board a project starts with rather than making another.
- **The migration narrows access, and says so.** A granted agent keeps the
  workflow verbs only on a person's own turn in a project channel it is in; a
  second WARNING names each agent whose trigger fires or DM-only use lose them.
- **The attention item is a `trigger_machine_access` bell row**, "<trigger>
  needs machine access: ask the machines' owner to set it up, from the
  trigger's page or the Agent Designer", opening the trigger's page. Until
  T4's Machine access section lands, the tool result, not the trigger page,
  says "Machine access: not set up". The row surfaces while the trigger's agent
  is live, no standing policy for it is preparing or live, and the recipient is
  an organisation owner; T4 links the section.
