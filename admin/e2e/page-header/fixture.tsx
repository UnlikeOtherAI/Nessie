import { faCircleDot, faCircleInfo, faGear, faMagnifyingGlass, faPaperclip, faPhone, faStar } from '@fortawesome/free-solid-svg-icons'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import {
  ResponsivePageHeader,
  type PageHeaderAction,
} from '../../src/components/shared/ResponsivePageHeader'
import '../../src/styles.css'

const projectActions: PageHeaderAction[] = [
  {
    id: 'configure',
    items: [
      { id: 'board-settings', label: 'Board settings…', onSelect: () => undefined },
      { id: 'new-board', label: 'New board…', onSelect: () => undefined },
    ],
    kind: 'menu',
    label: 'Configure',
    priority: 60,
  },
  { id: 'members', label: 'Members (1)', onSelect: () => undefined, priority: 80 },
  { id: 'new-task', label: 'New task', onSelect: () => undefined, primary: true, priority: 100 },
]

const channelActions: PageHeaderAction[] = [
  { compact: true, icon: faStar, id: 'favorite', label: 'Add favorite', onSelect: () => undefined, priority: 90 },
  { compact: true, icon: faCircleInfo, id: 'info', label: 'Conversation info', onSelect: () => undefined, priority: 80 },
  { compact: true, icon: faGear, id: 'settings', label: 'Channel settings', onSelect: () => undefined, priority: 60 },
  {
    compact: true,
    icon: faCircleDot,
    id: 'record',
    label: 'Record routine',
    onSelect: () => undefined,
    priority: 55,
    tone: 'danger',
  },
  { compact: true, disabled: true, icon: faPhone, id: 'call', label: 'Start a call', onSelect: () => undefined, priority: 50 },
  {
    compact: true,
    icon: faMagnifyingGlass,
    id: 'search',
    label: 'Search messages',
    onSelect: () => undefined,
    pressed: true,
    priority: 40,
    selected: true,
  },
  { id: 'join', label: 'Join', onSelect: () => undefined, primary: true, priority: 100 },
]

const secretsActions: PageHeaderAction[] = [
  { id: 'new-secret', label: 'New secret', onSelect: () => undefined, primary: true, priority: 100 },
]

const profileActions: PageHeaderAction[] = [
  { id: 'sign-out', label: 'Sign out', onSelect: () => undefined, priority: 100 },
]

const knowledgeActions: PageHeaderAction[] = [
  { icon: faPaperclip, id: 'attachments', label: 'Attachments', onSelect: () => undefined, priority: 60 },
  { id: 'upload', label: 'Upload file', onSelect: () => undefined, priority: 40 },
  { disabled: true, id: 'edit', label: 'Edit', onSelect: () => undefined, priority: 30 },
  { id: 'new-page', label: 'New page', onSelect: () => undefined, primary: true, priority: 100 },
]

const THEMES = ['sandstone', 'space-white', 'nebula', 'daylight', 'midnight', 'ocean'] as const

const Board = ({ theme }: { theme: string }) => (
  <div data-theme={theme === 'nebula' ? undefined : theme} data-theme-board={theme}>
    <p className="px-4 pb-1 pt-6 text-[11px] font-semibold uppercase tracking-wide opacity-60">
      {theme}
    </p>
    <div className="bg-[color:var(--main)] text-[color:var(--tx)]">
      <ResponsivePageHeader actions={projectActions} eyebrow="Project" title="Nessie" />
      <ResponsivePageHeader actions={channelActions} title="# general" />
      <ResponsivePageHeader actions={knowledgeActions} title="Knowledge" />
      <ResponsivePageHeader actions={secretsActions} eyebrow="Organization" title="Secrets" />
      <ResponsivePageHeader actions={profileActions} eyebrow="User" title="Profile" />
    </div>
  </div>
)

const Fixture = () => (
  <MemoryRouter initialEntries={['/projects/demo']}>
    <main className="min-h-screen bg-[color:var(--main)] text-[color:var(--tx)]">
      {THEMES.map((theme) => <Board key={theme} theme={theme} />)}
    </main>
  </MemoryRouter>
)

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Page header fixture root is missing.')
createRoot(root).render(<Fixture />)
