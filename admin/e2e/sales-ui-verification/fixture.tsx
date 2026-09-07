import { createRoot } from 'react-dom/client'

import { TodoTemplateEditor } from '../../src/components/features/agents/todos/TodoTemplateEditor'
import '../../src/styles.css'

const Fixture = () => (
  <main className="min-h-screen bg-[color:var(--main)] p-8 text-[color:var(--tx)]">
    <div className="mx-auto max-w-3xl">
      <TodoTemplateEditor onCancel={() => undefined} onSave={async () => undefined} saving={false} />
    </div>
  </main>
)

const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Fixture root is missing.')
createRoot(root).render(<Fixture />)
