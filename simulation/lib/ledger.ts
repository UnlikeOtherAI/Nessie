import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The ledger is an append-only runtime log of the simulation, not project
// documentation. It lives under the gitignored simulation/state/ directory
// (alongside screenshots) so it stays out of git and the docs structure lint.
const LEDGER_PATH = resolve(__dirname, '../state/ledger.md')

export type LedgerStatus = 'ok' | 'fail' | 'note'

export const writeLedger = (slug: string, action: string, status: LedgerStatus, detail = ''): void => {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
  const line = `${ts}  ${slug.padEnd(18)}  ${action.padEnd(22)}  ${status.padEnd(4)}  ${detail}\n`
  mkdirSync(dirname(LEDGER_PATH), { recursive: true })
  appendFileSync(LEDGER_PATH, line, 'utf8')
}
