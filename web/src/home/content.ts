import {
  faBolt,
  faBook,
  faBriefcase,
  faClipboardCheck,
  faClock,
  faCoins,
  faComments,
  faEnvelopeOpenText,
  faGlobe,
  faHashtag,
  faListCheck,
  faMagnifyingGlass,
  faPlug,
  faRobot,
  faServer,
  faUserShield,
  faVideo,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'

// Everything the homepage says lives here, so copy edits never touch layout.
// Items marked `placeholder` are deliberately unfinished: no metric or quote
// ships until it is a real, sourced one.

export const signInUrl = 'https://app.nessie.works/login?launch=sso'
export const docsUrl = 'https://github.com/UnlikeOtherAI/nessie'

export const navLinks = [
  { label: 'Product', href: '#context' },
  { label: 'Agents', href: '#agents' },
  { label: 'Self-hosting', href: '#control' },
  { label: 'Resources', href: '#resources' },
]

export const hero = {
  eyebrow: 'The European Slack alternative',
  title: 'Your team and its agents, in one conversation.',
  text: 'Nessie keeps the channels, threads and DMs people already know — and adds agents that draft, post and follow up right where the team is looking.',
}

export type HeroTab = { label: string; src: string; alt: string; caption: string }

export const heroTabs: HeroTab[] = [
  {
    label: 'Ask in a thread',
    src: '/screenshots/nessie-assistant.png',
    alt: 'A Nessie thread where the assistant drafts an all-team note about a new expense policy',
    caption: 'The assistant drafts the note in the thread where it was asked.',
  },
  {
    label: 'It follows through',
    src: '/screenshots/nessie-actions.png',
    alt: 'The assistant confirming it posted the note to #General and scheduled a follow-up',
    caption: 'It posts to #General and schedules Monday’s follow-up on its own.',
  },
  {
    label: 'The team reads it',
    src: '/screenshots/nessie-channel.png',
    alt: 'The #General channel in Nessie showing the published expense policy note',
    caption: 'The result lands in the channel everyone already reads.',
  },
]

const [assistantShot, actionsShot, channelShot] = heroTabs as [HeroTab, HeroTab, HeroTab]

export type Card = { icon: IconDefinition; title: string; text: string }

export const agentCards: Card[] = [
  { icon: faRobot, title: 'A personal assistant for everyone', text: 'Ask for a draft, a summary or a reminder in plain language — in any language.' },
  { icon: faEnvelopeOpenText, title: 'Review mail from chat', text: 'Connected mailboxes surface in the conversation, and replies wait for your approval.' },
  { icon: faClock, title: 'Scheduled follow-ups', text: 'Agents set their own triggers and come back when the work is due.' },
  { icon: faPlug, title: 'Tools through MCP', text: 'Give agents the connectors they need, scoped per organisation, team or project.' },
  { icon: faVideo, title: 'Call your assistant', text: 'Talk it through by voice in the browser or on iPhone when typing is slower.' },
  { icon: faClipboardCheck, title: 'Approval gates', text: 'Anything with consequences pauses for a person before it happens.' },
]

export type Update = { tag: string; title: string; text: string }

export const updates: Update[] = [
  { tag: 'New', title: 'Invite into several teams at once', text: 'One invitation from the organisation roster.' },
  { tag: 'New', title: 'Private browser access', text: 'Hand an agent a browser session, take control any time.' },
  { tag: 'Improved', title: 'Chat-side mail drafts', text: 'Review and approve replies without opening your inbox.' },
  { tag: 'New', title: 'Paired agents', text: 'Publish a Nessie agent as an MCP server for other tools.' },
  { tag: 'Improved', title: 'Named conversations', text: 'Agent DMs are titled by what you first asked.' },
]

export type Pillar = {
  id: string
  label: string
  title: string
  text: string
  features: Card[]
  image: HeroTab
  stat: { value: string; text: string; placeholder?: boolean }
  reverse?: boolean
}

export const pillars: Pillar[] = [
  {
    id: 'context',
    label: 'Context',
    title: 'Every answer starts from what your team already knows.',
    text: 'Knowledge, boards and conversations sit in one place, so agents work from your context instead of guessing.',
    features: [
      { icon: faBook, title: 'Team knowledge', text: 'Documents and PDFs agents can read and cite, per project.' },
      { icon: faMagnifyingGlass, title: 'Search that understands', text: 'Find the decision, not just the keyword.' },
      { icon: faListCheck, title: 'Boards in the loop', text: 'Work items agents can update as the conversation moves.' },
    ],
    image: assistantShot,
    stat: { value: '—', text: 'Metric placeholder: add a sourced figure before launch.', placeholder: true },
  },
  {
    id: 'agents',
    label: 'People',
    title: 'People and agents, side by side.',
    text: 'Agents join channels and DMs like colleagues — visible, named and accountable for what they post.',
    features: [
      { icon: faHashtag, title: 'Channels inside projects', text: 'Organisation → team → project → channel, so work has one home.' },
      { icon: faComments, title: 'Threads and DMs', text: 'The shape of conversation your team already uses.' },
      { icon: faVideo, title: 'Built-in calls', text: 'Video calls without leaving the workspace.' },
    ],
    image: channelShot,
    stat: { value: '—', text: 'Metric placeholder: add a sourced figure before launch.', placeholder: true },
    reverse: true,
  },
  {
    id: 'work',
    label: 'Work',
    title: 'Hand off the routine. Keep the judgement.',
    text: 'Triggers, schedules and work distribution move tasks forward — and approval gates keep people in charge.',
    features: [
      { icon: faBolt, title: 'Triggers and schedules', text: 'Run agents on a timer or when something happens.' },
      { icon: faBriefcase, title: 'Work distribution', text: 'Route tasks to the right person or agent.' },
      { icon: faClipboardCheck, title: 'Approvals', text: 'A clear yes before anything leaves the building.' },
    ],
    image: actionsShot,
    stat: { value: '—', text: 'Metric placeholder: add a sourced figure before launch.', placeholder: true },
  },
  {
    id: 'control',
    label: 'Control',
    title: 'Your servers. Your rules. Your data in Europe.',
    text: 'Host Nessie yourself, sign in through your own SSO, and see exactly what every agent did and what it cost.',
    features: [
      { icon: faServer, title: 'Self-hosted', text: 'Run your own instance; free for internal use.' },
      { icon: faUserShield, title: 'RBAC and audit trail', text: 'Roles, scopes and a record of every action.' },
      { icon: faCoins, title: 'Token-cost ledger', text: 'Attribute agent spend to teams and projects.' },
    ],
    image: assistantShot,
    stat: { value: '2 yrs', text: 'after each release, its code converts to Apache 2.0 under FSL-1.1-ALv2.' },
    reverse: true,
  },
]

export const facts = [
  { value: '4', text: 'levels of structure: organisation, team, project, channel' },
  { value: '100%', text: 'self-hostable on infrastructure you choose' },
  { value: 'EU', text: 'built in Europe, for teams who care where data lives' },
  { value: 'Any', text: 'language — intent is understood, not keyword-matched' },
]

export const quotes = [
  { text: 'Customer quote placeholder — replace with a real, approved testimonial.', who: 'Name, Role, Company' },
  { text: 'Customer quote placeholder — replace with a real, approved testimonial.', who: 'Name, Role, Company' },
]

export const resources = [
  { icon: faBook, kind: 'Docs', title: 'Nessie on GitHub: README and docs', cta: 'Read the docs', href: docsUrl },
  { icon: faServer, kind: 'Guide', title: 'Deploy Nessie on your own servers', cta: 'Start hosting', href: docsUrl },
  { icon: faUserShield, kind: 'Licence', title: 'What FSL-1.1-ALv2 lets you do', cta: 'Read the licence', href: docsUrl },
  { icon: faGlobe, kind: 'Product', title: 'Why a European alternative matters', cta: 'Coming soon', href: '#top' },
]

export const footerColumns = [
  { title: 'Product', links: ['Channels', 'Agents', 'Knowledge', 'Calls', 'Apps'] },
  { title: 'Platform', links: ['Self-hosting', 'SSO', 'Security', 'MCP connectors', 'Licence'] },
  { title: 'Company', links: ['About', 'Blog', 'Careers', 'Contact'] },
]
