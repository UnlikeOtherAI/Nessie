import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/styles.css'
import { CreateMenuTrigger } from '../../src/layouts/admin-shell/CreateMenuTrigger'
import { TransientMenuProvider } from '../../src/layouts/admin-shell/TransientMenuContext'

const rail: React.CSSProperties = {
  alignItems: 'center',
  background: 'var(--rail)',
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  justifyContent: 'flex-end',
  paddingBottom: 54,
  width: 65,
}

const workspace: React.CSSProperties = {
  background: 'linear-gradient(120deg, var(--sb), var(--main))',
  flex: 1,
  height: '100vh',
  overflow: 'hidden',
  padding: 30,
}

createRoot(document.getElementById('root')!).render(
  <TransientMenuProvider>
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={rail}>
        <CreateMenuTrigger
          onCreateAgent={() => undefined}
          onCreateChannel={() => undefined}
          onCreateMessage={() => undefined}
          onCreateProject={() => undefined}
        />
      </aside>
      <main style={workspace}>
        <h1 style={{ color: 'var(--tx)', fontSize: 28, fontWeight: 700 }}>Agents</h1>
        <p style={{ color: 'var(--tx3)', marginTop: 10 }}>Your workspace</p>
        <div style={{ background: 'var(--accent-soft)', borderRadius: 20, height: 180, marginTop: 70, width: 360 }} />
      </main>
    </div>
  </TransientMenuProvider>,
)
