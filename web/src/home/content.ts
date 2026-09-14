import {
  faBook,
  faClipboardCheck,
  faClock,
  faCoins,
  faComments,
  faEnvelopeOpenText,
  faGlobe,
  faHashtag,
  faPlug,
  faRobot,
  faServer,
  faUserShield,
  faVideo,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'

// Everything the homepage says lives here, so copy edits never touch layout.
// Anything flagged `placeholder` renders with a dashed outline: no metric,
// logo, rating or customer story ships until it is real and approved.

export const signInUrl = 'https://app.nessie.works/login?launch=sso'
export const docsUrl = 'https://github.com/UnlikeOtherAI/nessie'
export const contactUrl = 'mailto:hello@nessie.works'

export const navItems = [
  { label: 'Product', href: '#product', menu: true },
  { label: 'Solutions', href: '#pillars', menu: true },
  { label: 'Self-hosting', href: '#control', menu: false },
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
  alt: 'A Nessie thread where the assistant drafts an all-team note about a new expense policy',
}
const actionsShot: Shot = {
  src: '/screenshots/nessie-actions.png',
  alt: 'The assistant confirming it posted the note to #General and scheduled a follow-up',
}
const channelShot: Shot = {
  src: '/screenshots/nessie-channel.png',
  alt: 'The #General channel in Nessie showing the published expense policy note',
}

export const hero = {
  title: 'Where your people and their agents get work done.',
  text: 'Nessie keeps the channels your team already knows. Its agents turn the conversation into finished work.',
}

export const heroTabs = [
  { label: 'Ask the assistant', shot: assistantShot },
  { label: 'Post an update', shot: actionsShot },
  { label: 'Run a project', shot: channelShot },
  { label: 'Review mail', shot: assistantShot },
  { label: 'Schedule follow-ups', shot: actionsShot },
]

export type Card = { icon: IconDefinition; title: string; text: string; tag?: string }

export const aiBand = {
  title: 'Agents that finish the job, not just the sentence.',
  text: 'Nessie’s agents work inside your channels with your team’s context — drafting, posting and following up, with a person’s approval wherever it matters.',
  cards: [
    { icon: faRobot, title: 'Ask your assistant to draft the announcement', text: 'In any language, from any thread.' },
    { icon: faEnvelopeOpenText, title: 'Approve mail replies from chat', text: 'Drafts wait for your yes.', tag: 'New' },
    { icon: faComments, title: 'Catch up on a thread you missed', text: 'The decisions, without the scroll.' },
    { icon: faPlug, title: 'Connect tools to agents with MCP', text: 'Scoped per team and project.' },
    { icon: faVideo, title: 'Talk it through with your assistant', text: 'Voice calls in the browser and on iPhone.' },
    { icon: faClock, title: 'Let an agent schedule the follow-up', text: 'It comes back when the work is due.' },
  ] satisfies Card[],
}

export const whatsNew = {
  title: 'What’s new in Nessie',
  link: 'See all updates',
  items: [
    { icon: faHashtag, tag: 'New feature', title: 'Invite into several teams at once', text: 'One invitation from the organisation roster.' },
    { icon: faGlobe, tag: 'New feature', title: 'Private browser access', text: 'Lend an agent a browser and take control any time.' },
    { icon: faEnvelopeOpenText, tag: 'Improvement', title: 'Mail drafts in chat', text: 'Review and approve replies without opening your inbox.' },
    { icon: faPlug, tag: 'New feature', title: 'Paired agents', text: 'Publish a Nessie agent as an MCP server for other tools.' },
    { icon: faVideo, tag: 'Improvement', title: 'Voice calls on iPhone', text: 'Call your assistant from the native app.' },
    { icon: faCoins, tag: 'Improvement', title: 'Cost per project', text: 'The token ledger now breaks spend down by project.' },
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
    id: 'context',
    label: 'Context',
    title: 'Give every agent the context your team already has.',
    text: 'Threads, documents and boards live together, so answers come from your work instead of guesswork.',
    rows: [
      {
        title: 'Your assistant, grounded in your work.',
        text: 'It reads the threads, documents and boards you can see — nothing more — and answers from them.',
        cta: 'Meet the assistant',
        shot: assistantShot,
      },
      {
        title: 'Knowledge your team can cite.',
        text: 'Add documents and PDFs to a project, and every answer can point back to its source.',
        cta: 'About knowledge',
        shot: channelShot,
      },
      {
        title: 'Find the decision, not the keyword.',
        text: 'Search understands what you meant, in whichever language you asked.',
        shot: actionsShot,
      },
    ],
    stat: { value: '—', text: 'Placeholder: add a measured, sourced figure before launch.' },
  },
  {
    id: 'people',
    label: 'People',
    title: 'Work together like people, even when some are agents.',
    text: 'Familiar channels, threads and DMs — with agents that show up as named, accountable colleagues.',
    rows: [
      {
        title: 'Everything starts in a channel.',
        text: 'Channels live inside teams and projects, so every conversation has an obvious home.',
        cta: 'How channels work',
        shot: channelShot,
      },
      {
        title: 'Pick up a call without leaving the thread.',
        text: 'Built-in video calls keep the discussion and its outcome in one place.',
        shot: assistantShot,
      },
      {
        title: 'Agents you can see and trust.',
        text: 'Every agent has a name, an owner and a record of what it posted.',
        shot: actionsShot,
      },
    ],
    quote: true,
  },
  {
    id: 'work',
    label: 'Work',
    title: 'Move the routine work without losing the judgement.',
    text: 'Triggers, schedules and work distribution keep tasks moving; approval gates keep people in charge.',
    rows: [
      {
        title: 'Triggers and schedules for anyone.',
        text: 'Run an agent on a timer or when something happens — no scripts needed.',
        cta: 'About triggers',
        shot: actionsShot,
      },
      {
        title: 'Hand work to the right person or agent.',
        text: 'Work distribution routes tasks and keeps track of who has what.',
        shot: channelShot,
      },
      {
        title: 'A person approves anything that matters.',
        text: 'Approval gates pause sensitive actions until someone says yes.',
        shot: assistantShot,
      },
    ],
    stat: { value: '—', text: 'Placeholder: add a measured, sourced figure before launch.' },
  },
  {
    id: 'control',
    label: 'Control',
    title: 'Self-hosted. Auditable. Yours.',
    text: 'Run Nessie on your own infrastructure and see exactly what happened, who approved it and what it cost.',
    rows: [
      {
        title: 'Run it where your data should live.',
        text: 'Host Nessie on infrastructure you choose — free for your organisation’s internal use.',
        cta: 'Hosting guide',
        shot: channelShot,
      },
      {
        title: 'Sign in through your own SSO.',
        text: 'Organisations, teams and members come from your identity provider, never a second copy.',
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
  title: 'Teams that run on Nessie',
  cards: Array.from({ length: 4 }, (_, i) => ({
    title: `Customer story ${i + 1} — placeholder`,
    text: 'Replace with a real, approved case study.',
  })),
}

export const statsBand = {
  title: 'Built for organisations that want to own their tools.',
  stats: [
    { value: '4', label: 'levels of structure: organisation, team, project and channel' },
    { value: 'Free', label: 'to self-host for your organisation’s internal use' },
    { value: '2 yrs', label: 'until each release becomes Apache 2.0 under FSL-1.1-ALv2' },
  ],
}

export const love = {
  title: 'Why teams choose Nessie.',
  facts: [
    { value: 'EU', label: 'designed and built in Europe' },
    { value: 'Any', label: 'language understood, slang and typos included' },
    { value: 'MCP', label: 'standard connectors for agent tools' },
    { value: 'iOS', label: 'native iPhone and iPad apps' },
  ],
  ratingPlaceholder: 'Review-site rating placeholder — add only a verified rating.',
}

export const promos = {
  title: 'Learn more about Nessie',
  items: [
    { icon: faBook, kind: 'Guide', title: 'Moving your team from another chat tool', cta: 'Read more', href: docsUrl },
    { icon: faServer, kind: 'Docs', title: 'Self-hosting Nessie, step by step', cta: 'Read the docs', href: docsUrl },
    { icon: faUserShield, kind: 'Licence', title: 'What FSL-1.1-ALv2 lets you do', cta: 'Learn more', href: docsUrl },
    { icon: faClipboardCheck, kind: 'Product', title: 'How approval gates keep agents accountable', cta: 'Learn more', href: docsUrl },
  ],
}

export const finalCta = { title: 'See what your team can do with Nessie.' }

export const footerColumns = [
  { title: 'Product', links: ['Channels', 'Agents', 'Knowledge', 'Calls', 'Apps'] },
  { title: 'Why Nessie', links: ['Self-hosting', 'Security', 'SSO', 'Licence'] },
  { title: 'Resources', links: ['Docs', 'Changelog', 'Guides', 'Support'] },
  { title: 'Company', links: ['About', 'Careers', 'Contact', 'Press'] },
]

export const legalLinks = ['Privacy', 'Terms', 'Cookie policy']
