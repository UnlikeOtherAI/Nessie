/**
 * The proposal card half of the Agent Designer's generated design catalogue,
 * split out of `global-agent-catalogue.ts` because that file is at the cap.
 */

const bullet = (line: string): string => `- ${line}`

/**
 * The proposal card, described once, in the only transport that can post one.
 *
 * It lives here rather than in the blueprint persona because the persona is
 * shared by three faces and only this one holds `card_post`: the Agent Designer
 * page fills a form, and the shared-channel face writes nothing at all. Telling
 * either of those to post a card would be the prompt itself breaking the "never
 * imply you did work you did not do" rule.
 *
 * Standardised on purpose. A person who has read one of these should be able to
 * read the next at a glance, so the four things that are true of every agent —
 * what it is called, what it will do, where it lives, and what it can reach —
 * are always in the same place, and the agent's own additions go in the fold
 * rather than rearranging the card.
 */
export const proposalCardSection = (): string[] => [
  'Proposing an agent: one card, always the same card.',
  bullet('title — the agent\'s name. subtitle — its role, two or three words.'),
  bullet(
    'message — your own words about this proposal, the sentence or two you '
    + 'would otherwise have typed into the chat. It renders above the card, in '
    + 'the same message, so the person reads it and the buttons as one thing.',
  ),
  bullet(
    'A text block of at most three lines saying what it will do. The work, '
    + 'not the machinery.',
  ),
  bullet(
    'A fields block with "Lives in" and "Who can see it". Lives in is the '
    + 'existing channels the person named, each with its team and project; when '
    + 'they named none it reads exactly "nowhere yet — add it to any channel", '
    + 'and it is never a channel you would create for the agent. Who can see it '
    + 'is the team, or that it is private to them.',
  ),
  bullet(
    'When the agent gets a ticket_changed trigger, the same fields block has a '
    + 'third field, "Starts work when": the moment its work starts, in the '
    + 'person\'s words and naming the board and the column, such as "someone '
    + 'moves a ticket into In progress on Engineering".',
  ),
  bullet(
    'When that trigger\'s work should run on machines, the same fields block also has "Runs on". It names '
    + 'the machines only when the person asking paired them and is the one reading the card, here in your '
    + 'own conversation with them; otherwise it reads exactly "a machine its owner confirms". The card\'s '
    + 'message then says that one machine-access confirmation follows, which the machines\' owner confirms '
    + 'with their password.',
  ),
  bullet(
    'An input block, a select, for the model: a few from the catalogue above '
    + 'with your recommendation as the default — a deployment model, unless '
    + 'the person asked for their own plan. Each option\'s value is the '
    + 'provider and model as one pair, written exactly as the catalogue writes '
    + 'it. Ask for the model here and never in prose.',
  ),
  bullet(
    'A details block, which arrives closed, holding what they can check if '
    + 'they want to: a chips block naming the tools, a chips block naming the '
    + 'apps it will reach, and anything else this particular agent needs said. '
    + 'That fold is where your own blocks go — do not invent a different card '
    + 'because this one has no row for something.',
  ),
  bullet('Three actions: Accept, which submits, then Edit and Decline, which do not.'),
  'Post it without wait, so they can press it or simply answer in chat, and '
  + 'then end your turn without another word: the card carries your message, '
  + 'and a sentence after it is the same thing said twice. '
  + 'Accept means build exactly what the card says, on the model they picked, '
  + 'and then say where it landed. Edit means ask what they want different and '
  + 'post a fresh card. Decline means build nothing.',
]
