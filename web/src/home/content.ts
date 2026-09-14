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

export const navItems = [
  { label: 'AI employees', href: '#teammates', menu: true },
  { label: 'Teamwork', href: '#teamwork', menu: true },
  { label: 'Your people', href: '#people', menu: false },
  { label: 'Resources', href: '#resources', menu: true },
  { label: 'Pricing', href: '#final', menu: false },
]

export const cookieCopy = {
  text: 'We use essential cookies to run this site. With your permission we also use analytics cookies to learn which pages help people.',
  policy: 'Cookie policy',
}

export type Shot = { src: string; alt: string }

const assistantShot: Shot = {
  src: '/screenshots/nessie-assistant.png',
  alt: 'A Nessie thread where an agent drafts an all-team note about a new expense policy',
}
const actionsShot: Shot = {
  src: '/screenshots/nessie-actions.png',
  alt: 'The agent confirming it posted the note to #General and scheduled a follow-up',
}
const channelShot: Shot = {
  src: '/screenshots/nessie-channel.png',
  alt: 'The #General channel in Nessie showing the note the agent published',
}

export const hero = {
  title: 'Grow your team. Keep your people.',
  text: 'Nessie gives you AI employees with a name, an email address and a seat in your channels. They take on the repetitive work, so your people can focus on customers and creative ideas. Nobody has to lose their job.',
}

export const heroTabs = [
  { label: 'Brief a teammate', shot: assistantShot },
  { label: 'It gets it done', shot: actionsShot },
  { label: 'The whole team sees it', shot: channelShot },
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
        shot: assistantShot,
      },
      {
        title: 'An inbox of its own.',
        text: 'Agents send and receive email, so customers, suppliers and colleagues reach them the way they already work.',
        shot: actionsShot,
      },
      {
        title: 'Knows only what it should.',
        text: 'Agents see the projects, documents and channels they are given — nothing more.',
        shot: channelShot,
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
        shot: channelShot,
      },
      {
        title: 'People and agents in one conversation.',
        text: 'Mention a person or an agent in the same thread; whoever is right for the job picks it up.',
        shot: assistantShot,
      },
      {
        title: 'Always on, never overloaded.',
        text: 'Triggers and schedules keep work moving overnight and at weekends, without anyone on call.',
        shot: actionsShot,
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
        shot: actionsShot,
      },
      {
        title: 'Room for creative work.',
        text: 'Research, formatting and first drafts arrive ready, so ideas get the attention they deserve.',
        shot: channelShot,
      },
      {
        title: 'Every person leads a team.',
        text: 'Each of your people can direct several agents, turning one role into the output of a whole department.',
        shot: assistantShot,
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
        shot: channelShot,
      },
      {
        title: 'Sign in through your own SSO.',
        text: 'Your organisation, teams and people come from your identity provider, never a second copy.',
        shot: assistantShot,
      },
      {
        title: 'Know what every agent did and what it cost.',
        text: 'An audit trail and a token-cost ledger attribute every action and every euro.',
        shot: actionsShot,
      },
    ],
    quote: true,
  },
]

export const quotePlaceholder = {
  text: 'Customer quote placeholder — replace with a real, approved testimonial.',
  who: 'Name, role, organisation',
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

export const footerColumns = [
  { title: 'Product', links: ['AI employees', 'Agent email', 'Channels', 'Knowledge', 'Apps'] },
  { title: 'Why Nessie', links: ['Your people', 'Self-hosting', 'Security', 'Licence'] },
  { title: 'Resources', links: ['Docs', 'Changelog', 'Guides', 'Support'] },
  { title: 'Company', links: ['About', 'Careers', 'Contact', 'Press'] },
]

export const legalLinks = ['Privacy', 'Terms', 'Cookie policy']
