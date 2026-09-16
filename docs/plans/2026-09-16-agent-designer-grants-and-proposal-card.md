# Designer grants and the proposal card

Amends [The Agent Designer](2026-09-02-agent-designer-global-agent.md) (D4, D6) and
[Agent chat cards](2026-09-01-agent-chat-cards.md) (§2.3).

## Why

Asked for an agent that reads an already-connected Sales Portal, the Agent Designer
designed the agent and closed with "connecting Sales Portal and giving him access to it
are separate owner steps you'll do after in Agents → Tools". Two defects in one
sentence: Nessie's internals recited as homework, for one step it could have done itself
and one that was already done. The proposal it made was also ordinary prose, so the
thing a person actually has to approve — what the agent will be able to reach — was a
paragraph to parse rather than a list to check.

## The connector verbs come back (amends D4)

D4 deliberately withheld `connector_*` and had the Designer point at `/apps` in words.

The *grant* was never the missing half. `agent_create` and `agent_update` have always
taken `toolPolicy`, and an active connector's registry row is an ordinary togglable
catalogue key, so the Designer could always give a new agent an app this organisation
has already connected. Approving the design is what approves that list; nothing further
should be asked for it, and no settings screen should be named for it.

What was missing was connecting an app that is **not** installed yet.
`connector_list`, `connector_library_search`, `connector_discover`,
`connector_install`, `connector_authorize`, `connector_test` and
`connector_set_secret` therefore join `AGENT_DESIGNER_BLUEPRINT.identityToolIds` under
D3. The boundary is unchanged: the gate admits them only on the Designer's own home DM,
on an interactive turn, from a live human requester, and `buildConnectorContext`
re-derives that person's live connector rights from the database — a shared-scope
install is refused to exactly the people `/api/mcp/*` refuses it to.

`connector_uninstall` stays out. Designing an agent is never a reason to take an app
away from everybody else using it.

Two consequences the persona now states in words:

- **Scope decides who the agent serves.** `isMcpRegistryRowExposed` resolves a
  `user`-scoped connection only for that person's own conversations with the agent, so a
  team-visible agent on a team app needs an organisation- or team-scoped install — an
  owner's action. When the only install is personal, the Designer says plainly that
  colleagues will not reach it.
- **Channel scope is never right from here.** `connector_install` defaults an unnamed
  channel scope to the run's own channel, which is the Designer's private DM with the
  person, not the room the agent will work in.

Explicit-grant tools — mailbox and calendar access, deep research, the cloud browser —
keep their owner-surface contract. Those have their own approval gates
([connected mailboxes](../standards/connected-mailboxes.md), the private-browser plan),
and a design conversation must not route around them. The persona names the capability,
says it needs an owner's grant on that agent, and carries on with everything else.

## The proposal card (amends D6)

The draft proposed before anything is built is now one fixed arrangement rather than
whatever the model composes that turn, so a person who has read one reads every later
one at a glance:

| Part | Block | Holds |
|---|---|---|
| Name | `title` | the agent's name; `subtitle` is its role |
| What it does | `text` | at most three lines — the work, not the machinery |
| Where it lives | `fields` | team, project and channel, or that it is private |
| Model | `input` `select` | a few catalogue models, recommendation as the default; each option's value is the exact `provider/model` pair |
| Everything else | `details`, closed | `chips` of tools, `chips` of apps, and whatever else this agent needs said |

**The fold is the extension point.** No card can anticipate every agent, which is why
the Designer's own blocks go inside `details` rather than into a different card.

Actions are **Accept** (`submits`, so the model choice travels with the press), **Edit**
and **Discard**. Accept means build exactly what the card says and then say where it
landed; Edit wakes the Designer to ask what should change and post a fresh card;
Discard builds nothing. The card is posted without `wait`, so a person may press it or
simply answer in chat.

The description lives in `buildGlobalAgentCatalogueBlock` under
`writeSurface: 'agent_tools'`, **not** in the shared persona: three faces read the
persona and only the DM face holds `card_post`. The Agent Designer page's sidebar fills
a form and the shared-channel face writes nothing, so telling either of them to post a
card would be the prompt itself breaking "never imply you did work you did not do".

## Two new card blocks (amends the cards plan §2.3)

`chips` and `details` are ordinary vocabulary, not a card kind — the "no
`kind: 'linear_ticket'`" rule is intact, and both render through the one block renderer.

- `chips` — `{ label?, items: string[] }`, ≤40 items of ≤60 characters. A set of named
  things that reads as a set.
- `details` — `{ summary, blocks }`, 1–6 blocks, one level, `text | fields | chips |
  link` only. No `input` and no `secret`: a field nobody has to open is a field somebody
  can submit unseen. No nesting: that is a layout language in waiting.

`renderAgentCardPlainText` **unfolds** a `details` block. That string is what search,
push previews and the model's own transcript window get instead of the card, so folding
it there would make the approved tool list readable in exactly one client.

## Verification

`pnpm --filter @nessie/admin test:e2e:agent-proposal-card` drives the real
`AgentCardMessage` over a stubbed presenter and screenshots the card closed and open. It
asserts the name, the role, the placement, the preselected model, that the fold arrives
closed with its tool words not visible, that opening it does not press the card, and
that the three actions are there.
