import { resolve } from 'node:path'
import { launchEmployee, ensureLoggedIn, screenshotDir } from './lib/employee.js'
import { writeLedger } from './lib/ledger.js'

const slug = process.argv[2]
if (!slug) {
  console.error('usage: tsx simulation/probe-employee.ts <slug>')
  process.exit(1)
}

const main = async (): Promise<void> => {
  const session = await launchEmployee(slug)
  try {
    await ensureLoggedIn(session)
    const shotPath = resolve(screenshotDir(slug), `dashboard-${Date.now()}.png`)
    await session.page.screenshot({ path: shotPath, fullPage: false })
    writeLedger(slug, 'screenshot.dashboard', 'ok', shotPath)
    console.log(`[probe] ${slug} ok — ${shotPath}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    writeLedger(slug, 'probe', 'fail', detail)
    console.error(`[probe] ${slug} failed: ${detail}`)
    process.exitCode = 1
  } finally {
    await session.close()
  }
}

await main()
