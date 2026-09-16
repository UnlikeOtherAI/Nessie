import {
  faBook,
  faCarSide,
  faClipboardCheck,
  faClock,
  faCoins,
  faEnvelope,
  faEnvelopeOpenText,
  faGlobe,
  faHashtag,
  faPenToSquare,
  faPeopleArrows,
  faPlug,
  faRepeat,
  faReply,
  faServer,
  faVideo,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'

// Everything the homepage says lives here, so copy edits never touch layout.
// The whole site makes one argument: Nessie's agents are real employees —
// named, with their own email, working with each other — so a team can grow
// without limit while its people move to customer and creative work.
// Anything flagged `placeholder` renders with a dashed outline: no metric,
// rating or customer story ships until it is real and approved.

export const signInUrl = 'https://app.nessie.works/login?launch=sso'
export const docsUrl = 'https://github.com/UnlikeOtherAI/nessie'
export const contactUrl = 'mailto:hello@nessie.works'

/**
 * The top navigation.
 *
 * `menu` means this item opens a real dropdown, built from `pages.ts` — it is
 * not decoration. An item that only scrolls the homepage has no chevron,
 * because a chevron on a link that goes straight somewhere is a promise the
 * header does not keep.
 */
export const navItems = [
  { href: '#teammates', label: 'AI employees', menu: 'none' },
  { href: '#teamwork', label: 'Teamwork', menu: 'none' },
  { href: '#people', label: 'Your people', menu: 'none' },
  { href: '#pricing', label: 'Pricing', menu: 'none' },
  { href: '/docs/installation', label: 'Docs', menu: 'resources' },
  { href: '/eu', label: 'Why Nessie', menu: 'why' },
] satisfies { href: string; label: string; menu: 'resources' | 'why' | 'none' }[]

export const cookieCopy = {
  text: 'We use essential cookies to run this site. With your permission we also use analytics cookies to learn which pages help people.',
  policy: 'Cookie policy',
}

export type Shot = { src: string; alt: string }

// Every picture on this page is cut out of the running product by
// `admin/e2e/marketing-shots` and re-taken with one command, so a claim and
// the screen behind it stay one decision. `web/public/screenshots/README.md`
// says which file backs which row.
const shot = (src: string, alt: string): Shot => ({ alt, src: `/screenshots/${src}.png` })

// The hero's three, painted into the 3D desktop's screen.
const briefShot = shot('hero-brief', 'A person asking an agent by name to pull a customer’s renewal details')
const handoffShot = shot('hero-handoff', 'Two agents settling a month-end discrepancy between them in one thread')
const teamShot = shot('hero-team', 'An organisation’s people, each with the agents they are responsible for')

// The pillar rows, each cut out with its own rounded, transparent edge.
const colleagueShot = shot('teammates-colleague', 'A roster where each person is listed with the agents they own, by name and role')
const inboxShot = shot('teammates-inbox', 'A customer’s email to an agent’s own address, and the agent’s reply')
const scopeShot = shot('teammates-scope', 'A channel listing the two agents that belong to it')
const handoffRowShot = shot('teamwork-handoff', 'One thread in which an agent hands a check to another and takes the work back')
const togetherShot = shot('teamwork-together', 'A thread with two people and an agent working on the same customer quote')
const alwaysOnShot = shot('teamwork-always-on', 'Scheduled and event triggers that run agents overnight and at weekends')
const approvalShot = shot('people-customers', 'Two agent actions stopped, waiting for a person to approve or reject them')
const briefingShot = shot('people-creative', 'A briefing document an agent wrote and published before the call')
const leadsShot = shot('people-leads', 'One person with several agents of their own listed beneath them')
const orgShot = shot('control-host', 'An organisation’s own settings on an instance its owners run')
const auditShot = shot('control-audit', 'An audit trail of what each agent did, and what was refused')

export const hero = {
  title: 'Hire new AI employees. Keep your people.',
  text: 'Nessie gives you AI employees with a name, an email address and a seat in your channels. They take on the repetitive work, so your people can focus on customers and creative ideas. Nobody has to lose their job.',
}

export const heroTabs = [
  { label: 'Brief a teammate', shot: briefShot },
  { label: 'It gets it done', shot: handoffShot },
  { label: 'The whole team sees it', shot: teamShot },
]

// Straight after the hero: every person gets an assistant that works like
// them, and any AI employee can be called like a colleague.
export const assistant = {
  kicker: 'Your personal assistant',
  title: 'Everyone gets an assistant that works the way they do.',
  text: 'Each person in your organisation gets their own AI assistant. It learns how you communicate, takes work off your plate, and checks with you before anything important goes out.',
  cards: [
    { icon: faClock, title: 'Schedules your messages', text: 'Write it now; it goes out when it should.' },
    { icon: faReply, title: 'Replies when a reply is needed', text: 'Keeps colleagues moving on the questions you would have answered anyway.' },
    { icon: faPenToSquare, title: 'Drafts emails in your voice', text: 'Prepares replies from your past conversations, ready for you to send.' },
  ] satisfies Card[],
  call: {
    icon: faCarSide,
    kicker: 'Voice calls',
    title: 'Plan the day on your way to work.',
    text: 'Call any of your AI employees like a colleague — from the car, the train or a walk. Hand out the day’s work to everyone and get ahead of your email before you arrive.',
    cta: 'How voice calls work',
  },
}

export type Card = { icon: IconDefinition; title: string; text: string; tag?: string }

export const aiBand = {
  title: 'Not bots. Real teammates.',
  text: 'Every Nessie agent is a first-class member of your team. It has its own email address, joins channels and DMs, works with other agents and with your people, and answers for what it does.',
  cards: [
    { icon: faEnvelope, title: 'Its own email address', text: 'Customers and colleagues write to it like anyone else.', tag: 'Core' },
    { icon: faPeopleArrows, title: 'Agents work with each other', text: 'They hand off, ask questions and share results.' },
    { icon: faHashtag, title: 'A seat in every channel', text: 'Mention it, message it, add it to a project.' },
    { icon: faRepeat, title: 'The repetitive work, handled', text: 'Reports, follow-ups, triage and updates — every time.' },
    { icon: faClipboardCheck, title: 'Asks before it matters', text: 'Anything consequential waits for a person’s approval.' },
    { icon: faCoins, title: 'Shows its work and its cost', text: 'Every action audited, every token accounted for.' },
  ] satisfies Card[],
}

export const whatsNew = {
  title: 'What’s new in Nessie',
  link: 'See all updates',
  items: [
    { icon: faHashtag, tag: 'New feature', title: 'Invite into several teams at once', text: 'One invitation from the organisation roster.' },
    { icon: faGlobe, tag: 'New feature', title: 'Private browser access', text: 'Lend an agent a browser and take control any time.' },
    { icon: faEnvelopeOpenText, tag: 'Improvement', title: 'Mail drafts in chat', text: 'Review and approve an agent’s replies without opening your inbox.' },
    { icon: faPlug, tag: 'New feature', title: 'Paired agents', text: 'Publish a Nessie agent as an MCP server for other tools.' },
    { icon: faVideo, tag: 'Improvement', title: 'Voice calls on iPhone', text: 'Call an agent from the native app.' },
    { icon: faCoins, tag: 'Improvement', title: 'Cost per project', text: 'See what each project’s agents spend.' },
  ] satisfies Card[],
}

export type PillarRow = { title: string; text: string; cta?: string; shot: Shot }

export type Pillar = {
  id: string
  label: string
  title: string
  text: string
  rows: PillarRow[]
  stat?: { value: string; text: string }
  quote?: boolean
}

export const pillars: Pillar[] = [
  {
    id: 'teammates',
    label: 'AI employees',
    title: 'Hire a teammate in minutes, not months.',
    text: 'Give an agent a role, a name and a person responsible for it. It joins your organisation like a new colleague — with an inbox, access to the right projects and nothing it shouldn’t see.',
    rows: [
      {
        title: 'A colleague, not a chatbot.',
        text: 'Each agent has a name, a role and an owner, and shows up in your team like anyone else.',
        cta: 'Meet your first agent',
        shot: colleagueShot,
      },
      {
        title: 'An inbox of its own.',
        text: 'Agents send and receive email, so customers, suppliers and colleagues reach them the way they already work.',
        shot: inboxShot,
      },
      {
        title: 'Knows only what it should.',
        text: 'Agents see the projects, documents and channels they are given — nothing more.',
        shot: scopeShot,
      },
    ],
    stat: { value: '—', text: 'Placeholder: add a measured, sourced figure before launch.' },
  },
  {
    id: 'teamwork',
    label: 'Teamwork',
    title: 'A team of agents that works like a team.',
    text: 'Agents talk to each other the way your people do: they pass work along, ask for help and report back where everyone can see.',
    rows: [
      {
        title: 'Handoffs without meetings.',
        text: 'One agent drafts, another checks the numbers, a third sends it — and the thread shows every step.',
        cta: 'How agents collaborate',
        shot: handoffRowShot,
      },
      {
        title: 'People and agents in one conversation.',
        text: 'Mention a person or an agent in the same thread; whoever is right for the job picks it up.',
        shot: togetherShot,
      },
      {
        title: 'Always on, never overloaded.',
        text: 'Triggers and schedules keep work moving overnight and at weekends, without anyone on call.',
        shot: alwaysOnShot,
      },
    ],
    quote: true,
  },
  {
    id: 'people',
    label: 'Your people',
    title: 'Nobody loses their job. Everyone gets a better one.',
    text: 'Hand the repetitive, boring work to agents, and give your people time for what AI can’t do: building relationships with customers and doing creative work.',
    rows: [
      {
        title: 'More time with customers.',
        text: 'Agents prepare the notes, send the follow-ups and chase the paperwork, so your people can listen and build trust.',
        cta: 'Stories from teams',
        shot: approvalShot,
      },
      {
        title: 'Room for creative work.',
        text: 'Research, formatting and first drafts arrive ready, so ideas get the attention they deserve.',
        shot: briefingShot,
      },
      {
        title: 'Every person leads a team.',
        text: 'Each of your people can direct several agents, turning one role into the output of a whole department.',
        shot: leadsShot,
      },
    ],
    stat: { value: '—', text: 'Placeholder: add a measured, sourced figure before launch.' },
  },
  {
    id: 'control',
    label: 'Control',
    title: 'A bigger team. Full control.',
    text: 'However many agents you add, you decide what they can do, approve what matters and see exactly what happened and what it cost.',
    rows: [
      {
        title: 'Run it where your data should live.',
        text: 'Host Nessie on infrastructure you choose — free for your organisation’s internal use.',
        cta: 'Hosting guide',
        shot: orgShot,
      },
      {
        // Borrowing the organisation shot: a local capture run has no identity
        // provider, so its sign-in screen reads "No sign-in providers are
        // configured". Re-take this one against a UOA-configured instance.
        title: 'Sign in through your own SSO.',
        text: 'Your organisation, teams and people come from your identity provider, never a second copy.',
        shot: orgShot,
      },
      {
        title: 'Know what every agent did and what it cost.',
        text: 'An audit trail and a token-cost ledger attribute every action and every euro.',
        shot: auditShot,
      },
    ],
    quote: true,
  },
]

export const quotePlaceholder = {
  text: 'Customer quote placeholder — replace with a real, approved testimonial.',
  who: 'Name, role, organisation',
}

// Hosted pricing, both amounts monthly. Storage is billed like object storage.
export const pricing = {
  kicker: 'Pricing',
  title: 'Simple pricing that grows with your team.',
  text: 'Pay per person and for the storage you use. AI employees don’t take a seat — they run on your own AI accounts at no extra charge, or on Nessie’s models for a per-token rate.',
  plan: {
    name: 'Nessie Cloud',
    price: { amount: '€3', unit: 'per user / month' },
    // Storage is one bill for the whole team, never multiplied by users.
    storage: { amount: '€10', unit: 'per TB of storage / month for the whole team — not per user' },
    // AI employees are never billed per seat; only inference Nessie provides is billed, per token.
    usageNote: 'AI employees are not charged per seat. When they run on Nessie’s models, usage is billed per token.',
    features: [
      'Channels, threads, DMs and calls',
      'Unlimited AI employees with their own email addresses',
      'A personal assistant for everyone',
      'Approval gates, audit trail and cost ledger',
    ],
    cta: 'Get started',
  },
  selfHost: {
    title: 'Prefer to host it yourself?',
    text: 'Nessie is free to self-host for your organisation’s internal use, on infrastructure you choose.',
    cta: 'Hosting guide',
  },
  // Text names only, no provider logos. Anthropic is deliberately not listed.
  byo: {
    title: 'Bring your own AI accounts',
    text: 'Connect the AI accounts you already pay for — subscriptions included — and your AI employees run on them with no extra charge from Nessie. Or use Nessie’s models and pay per token.',
    providers: ['OpenAI Codex', 'Kimi', 'Z.ai', 'OpenRouter'],
    more: 'and more',
  },
}

export const stories = {
  title: 'Teams that grew with Nessie',
  cards: Array.from({ length: 4 }, (_, i) => ({
    title: `Customer story ${i + 1} — placeholder`,
    text: 'Replace with a real, approved case study.',
  })),
}

export const statsBand = {
  title: 'One person. A whole team behind them.',
  stats: [
    { value: 'Email', label: 'a real address for every agent, not a bot integration' },
    { value: '24/7', label: 'agents keep working while your people rest' },
    { value: 'Free', label: 'to self-host for your organisation’s internal use' },
  ],
}

export const love = {
  title: 'What your people get back.',
  facts: [
    { value: 'Time', label: 'back from repetitive, boring tasks' },
    { value: 'Focus', label: 'on the work only people can do' },
    { value: 'Clients', label: 'relationships that get real attention' },
    { value: 'Ideas', label: 'creative work with room to breathe' },
  ],
  ratingPlaceholder: 'Review-site rating placeholder — add only a verified rating.',
}

export const promos = {
  title: 'Learn more about AI employees',
  items: [
    { icon: faBook, kind: 'Guide', title: 'Hiring your first AI employee', cta: 'Read more', href: docsUrl },
    { icon: faPeopleArrows, kind: 'Guide', title: 'How agents work with each other', cta: 'Read more', href: docsUrl },
    { icon: faServer, kind: 'Docs', title: 'Self-hosting Nessie, step by step', cta: 'Read the docs', href: docsUrl },
    { icon: faClipboardCheck, kind: 'Product', title: 'How approval gates keep agents accountable', cta: 'Learn more', href: docsUrl },
  ],
}

export const finalCta = { title: 'Your team is about to get a lot bigger.' }

/**
 * Footer columns. Every entry is a destination that exists — a link to a page
 * nobody has written is worse than no link, and the columns shrank to what is
 * real rather than keeping four tidy rows of `#top`.
 */
export const footerColumns = [
  {
    links: [
      { href: '#teammates', label: 'AI employees' },
      { href: '#teamwork', label: 'Teamwork' },
      { href: '#people', label: 'Your people' },
      { href: '#pricing', label: 'Pricing' },
    ],
    title: 'Product',
  },
  {
    links: [
      { href: '/docs/installation', label: 'Installation' },
      { href: '/docs/api', label: 'API' },
      { href: '/docs/mcp', label: 'MCP' },
      { href: '/docs/executors', label: 'Remote executors' },
    ],
    title: 'Documentation',
  },
  {
    links: [
      { href: '/eu', label: 'EU made and data residency' },
      { href: docsUrl, label: 'Source code' },
      { href: `${docsUrl}/blob/main/LICENSE`, label: 'Licence' },
      { href: contactUrl, label: 'Contact' },
    ],
    title: 'Why Nessie',
  },
] satisfies { links: { href: string; label: string }[]; title: string }[]

export const legalLinks = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
]

// Case colours for the 3D desktop: `front` tints the chin and stand, `back`
// the rear shell. The choice is remembered in a cookie (colour-cookie.ts).
export type DeviceColour = { id: string; name: string; front: string; back: string }

export const deviceColours: DeviceColour[] = [
  { id: 'green', name: 'Green', front: '#bfe6cf', back: '#8fcdaa' },
  { id: 'yellow', name: 'Yellow', front: '#f6e3a1', back: '#eccb62' },
  { id: 'orange', name: 'Orange', front: '#f8c7a6', back: '#ee9f73' },
  { id: 'pink', name: 'Pink', front: '#f6c7d0', back: '#e8a0b0' },
  { id: 'purple', name: 'Purple', front: '#cfc8f0', back: '#a99fdc' },
  { id: 'blue', name: 'Blue', front: '#b9d1fb', back: '#8fb0ea' },
  { id: 'silver', name: 'Silver', front: '#e7e8ec', back: '#c9ccd3' },
]

export const defaultDeviceColour = 'pink'

// CC BY 4.0 requires title, author, source, licence and a note of changes.
export const modelCredit = {
  title: 'iMac 2021',
  author: 'DatSketch',
  sourceUrl: 'https://sketchfab.com/3d-models/imac-2021-304cb06ffb554883a7a642b2b56754c1',
  licence: 'CC BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  changes: 'recoloured, manufacturer logo removed, screen image replaced',
}
