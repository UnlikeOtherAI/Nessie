import { createRoot } from 'react-dom/client'

import { TeamAvatar } from '../../src/components/primitives/TeamAvatar'
import '../../src/styles.css'

const icon = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect width="64" height="64" rx="14" fill="#efe7ff"/>
    <circle cx="22" cy="22" r="13" fill="#f4c430"/>
    <circle cx="42" cy="22" r="13" fill="#7c3aed"/>
    <circle cx="22" cy="42" r="13" fill="#22c55e"/>
    <circle cx="42" cy="42" r="13" fill="#ec4899"/>
  </svg>
`)}`

const Avatar = ({ size }: { size: number }) => (
  <TeamAvatar
    directoryImageFirst
    imageUrl={icon}
    label="Rafiki"
    size={size}
    teamId="new-team"
    token="fixture-token"
  />
)

const Board = ({ mobile = false }: { mobile?: boolean }) => (
  <section
    data-board={mobile ? 'mobile' : 'desktop'}
    style={{
      background: '#f8f7fb',
      border: '1px solid #ddd8e7',
      borderRadius: 18,
      boxSizing: 'border-box',
      color: '#191724',
      padding: 18,
      width: mobile ? 'calc(100vw - 32px)' : 520,
    }}
  >
    <div style={{ alignItems: 'center', display: 'flex', gap: 10, marginBottom: 18 }}>
      <Avatar size={mobile ? 28 : 32} />
      <strong>Rafiki</strong>
      <span aria-hidden="true">⌄</span>
    </div>
    <div style={{ background: 'white', borderRadius: 14, boxShadow: '0 12px 30px #32284c22', padding: 12 }}>
      <small style={{ color: '#6f687c', display: 'block', marginBottom: 10 }}>TEAMS</small>
      <div style={{ alignItems: 'center', display: 'flex', gap: 12 }}>
        <Avatar size={36} />
        <div><strong style={{ display: 'block' }}>Rafiki</strong><small>rafiki</small></div>
        <span style={{ marginLeft: 'auto' }}>✓</span>
      </div>
    </div>
  </section>
)

createRoot(document.getElementById('root')!).render(
  <main style={{ alignItems: 'center', display: 'flex', flexDirection: 'column', gap: 24, padding: 16 }}>
    <Board />
    <Board mobile />
  </main>,
)
