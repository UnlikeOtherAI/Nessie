import { appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const LEDGER_PATH = resolve(__dirname, '../../docs/simulation/ledger.md')

export type LedgerStatus = 'ok' | 'fail' | 'note'

export const writeLedger = (slug: string, action: string, status: LedgerStatus, detail = ''): void => {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z')
  const line = `${ts}  ${slug.padEnd(18)}  ${action.padEnd(22)}  ${status.padEnd(4)}  ${detail}\n`
  appendFileSync(LEDGER_PATH, line, 'utf8')
}
