// The Phase 3a stub harness.
//
// Phase 2's routes do not exist yet, so the pane is driven against
// `SpreadsheetBootstrapSchema` with a stubbed `fetch`: the snapshot is the
// checked-in `.icalc` fixture, built by `createNodeModel(...).toBytes()`, which
// is exactly what the bootstrap route will serve. Everything above the wire —
// the lazy chunk boundary, the engine, the bridge, the theme, the action bar,
// the dialogs and the phone layout — is the real thing.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, StrictMode, Suspense, useState } from 'react'
import { createRoot } from 'react-dom/client'

import icalcUrl from '../../test/fixtures/q3-forecast.icalc?url'
import {
  cellRect,
} from '../../src/components/features/knowledge/spreadsheet/spreadsheet-geometry'
import type { WorkbookSession } from '../../src/components/features/knowledge/spreadsheet/WorkbookHost'
import type { KnowledgePageRecord } from '../../src/facades/knowledge/hooks'
import { ApiClientProvider } from '../../src/providers/ApiClientProvider'
import { AuthSessionProvider } from '../../src/providers/AuthSessionProvider'
import '../../src/styles.css'

// The whole IronCalc surface sits behind this one dynamic import, exactly as
// `KnowledgeDocumentPane` lazy()-imports the real pane — which is what the
// network-log assertion in run.mjs measures.
const SpreadsheetPane = lazy(
  () => import('../../src/components/features/knowledge/spreadsheet/SpreadsheetPane'),
)

const PAGE_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000105'
const TIMESTAMP = '2026-09-16T10:00:00.000Z'

const page = {
  childPageIds: [],
  createdAt: TIMESTAMP,
  id: PAGE_ID,
  kind: 'spreadsheet',
  labels: [],
  latestVersion: null,
  metadata: null,
  parentPageId: null,
  policyChainTrace: [],
  position: 0,
  publishedVersion: null,
  publishedVersionId: null,
  sourceRef: 'fixture',
  spaceId: '00000000-0000-4000-8000-000000000002',
  status: 'published',
  summary: null,
  title: 'Q3 Forecast',
  updatedAt: TIMESTAMP,
  visibilityReason: 'fixture',
} as unknown as KnowledgePageRecord

const me = {
  auth: { autoRedirectToSso: false, providerId: 'local', providerType: 'local-bootstrap' as const },
  context: {
    bootstrapMode: false,
    organizationId: '00000000-0000-4000-8000-000000000102',
    projectId: '00000000-0000-4000-8000-000000000103',
    teamId: '00000000-0000-4000-8000-000000000104',
  },
  session: { issuedAt: TIMESTAMP, sessionId: 'spreadsheet-shell-e2e' },
  user: {
    displayName: 'Taylor',
    email: 'taylor@example.test',
    id: USER_ID,
    roleIds: ['owner'],
    superAdmin: false,
  },
}

const version = (versionNumber: number, authorType: 'agent' | 'user', changeComment: string) => ({
  attachmentId: null,
  authorId: authorType === 'agent' ? 'agent-1' : USER_ID,
  authorType,
  body: null,
  bodyRef: null,
  changeComment,
  createdAt: TIMESTAMP,
  id: `00000000-0000-4000-8000-00000000010${versionNumber}`,
  pageId: PAGE_ID,
  policyChainTrace: [],
  sourceContentHash: null,
  sourceRef: 'fixture',
  versionNumber,
  visibilityReason: 'fixture',
})

const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const snapshot = base64(
  new Uint8Array(await fetch(icalcUrl).then((response) => response.arrayBuffer())),
)

const bootstrap = {
  batches: [],
  engineVersion: '0.8.3',
  headSeq: 0,
  pageId: PAGE_ID,
  revision: 1,
  sheets: [{ color: null, hidden: false, index: 0, name: 'Sheet1' }],
  snapshot: { bytes: snapshot, seq: 0 },
  title: 'Q3 Forecast',
  viewer: {
    actor: { color: '#2563eb', displayName: 'Taylor', id: USER_ID, type: 'user' as const },
    canWrite: true,
  },
}

// A filter on column C ("Owner"), so the funnel buttons and the chips bar are
// on screen for the screenshot rather than behind a server round trip.
const filterModel = {
  appliedAtSeq: '0',
  columns: { 3: { blanks: false, kind: 'values' as const, values: ['Dana'] } },
  range: { c0: 1, c1: 3, r0: 1, r1: 5 },
}

window.localStorage.setItem('nessie.admin.token', 'spreadsheet-shell-e2e')
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    window.location.origin,
  )
  // The wasm and the `.icalc` are real assets served by this same origin.
  if (!url.pathname.startsWith('/api/')) return realFetch(input as RequestInfo, init)
  if (url.pathname === '/api/auth/me') return Response.json({ data: me })
  if (url.pathname === `/api/knowledge-base/pages/${PAGE_ID}/spreadsheet`) {
    return Response.json({ data: bootstrap })
  }
  if (url.pathname === `/api/knowledge-base/pages/${PAGE_ID}/spreadsheet/filters/0`) {
    return Response.json({ data: filterModel })
  }
  if (url.pathname === `/api/knowledge-base/pages/${PAGE_ID}/versions`) {
    return Response.json({
      data: [
        version(3, 'agent', 'before: delete rows 2-4'),
        version(2, 'user', 'named: before the Q4 re-forecast'),
        version(1, 'user', 'import: q3-forecast.xlsx'),
      ],
    })
  }
  return Response.json({ data: null })
}

// The driver the e2e run selects a range through. IronCalc's own
// `.ic-worksheet-cell-outline` covers the canvas, so a Playwright click on a
// cell needs raw coordinates, and only the model knows the column widths. This
// is fixture-only: the pane exposes `onSession` for Phase 3b's live lane, and
// this is that same seam used to drive a test.
declare global {
  interface Window {
    __spreadsheetShell?: {
      cellPoint: (row: number, column: number) => { x: number; y: number }
      selection: () => number[]
    }
  }
}

const publishDriver = (session: WorkbookSession | null): void => {
  if (!session) {
    delete window.__spreadsheetShell
    return
  }
  window.__spreadsheetShell = {
    cellPoint: (row, column) => {
      const container = document.querySelector('.ic-worksheet-sheet-container')
      const frame = container?.getBoundingClientRect() ?? { left: 0, top: 0 }
      const rect = cellRect(session.model, session.model.getSelectedView().sheet, row, column)
      return {
        x: frame.left + rect.left + rect.width / 2,
        y: frame.top + rect.top + rect.height / 2,
      }
    },
    selection: () => Array.from(session.model.getSelectedView().range),
  }
}

const Fixture = () => {
  // The gate the lazy-load proof needs: nothing IronCalc is fetched until it is
  // pressed, which is what `KnowledgeDocumentPane` does on a page open.
  const [open, setOpen] = useState(
    new URLSearchParams(window.location.search).get('open') === '1',
  )

  if (!open) {
    return (
      <div className="flex h-screen items-center justify-center bg-[color:var(--main)]">
        <button
          className="admin-button admin-button-primary"
          data-testid="open-spreadsheet"
          onClick={() => setOpen(true)}
          type="button"
        >
          Open spreadsheet
        </button>
      </div>
    )
  }

  return (
    <div className="h-screen bg-[color:var(--main)] text-[color:var(--tx)]">
      <Suspense
        fallback={<p data-testid="spreadsheet-chunk-loading">Opening Q3 Forecast…</p>}
      >
        <SpreadsheetPane canWrite onSession={publishDriver} page={page} />
      </Suspense>
    </div>
  )
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const root = document.querySelector('#root')
if (!(root instanceof HTMLElement)) throw new Error('Spreadsheet shell fixture root is missing.')
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthSessionProvider>
        <ApiClientProvider>
          <Fixture />
        </ApiClientProvider>
      </AuthSessionProvider>
    </QueryClientProvider>
  </StrictMode>,
)
