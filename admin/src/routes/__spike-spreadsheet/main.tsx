// Throwaway Spike C/D entry. Served by Vite at
// /src/routes/__spike-spreadsheet/index.html; nothing in the admin imports it.
import { lazy, StrictMode, Suspense, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../../styles.css'
import './spike.css'

// The whole IronCalc surface — widget JS, its CSS and the 1.9 MB wasm — sits
// behind this one dynamic import, exactly as `KnowledgeDocumentPane` will
// lazy() the real pane. Nothing is fetched until "Open spreadsheet".
const SpikeWorkbook = lazy(() => import('./SpikeWorkbook'))

// `?auto=1` skips the lazy-load gate, for driving the page by hand on a real
// device where the network-log proof is not what is being measured.
const autoOpen = new URLSearchParams(window.location.search).get('auto') === '1'

const Spike = (): React.ReactElement => {
  const [open, setOpen] = useState(autoOpen)
  if (!open) {
    return (
      <button data-testid="open-spreadsheet" onClick={() => setOpen(true)} type="button">
        Open spreadsheet
      </button>
    )
  }
  return (
    <Suspense fallback={<p data-testid="spike-loading">loading chunk…</p>}>
      <SpikeWorkbook />
    </Suspense>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(<StrictMode><Spike /></StrictMode>)
