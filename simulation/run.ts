import { allEmployees } from './lib/employee.js'
import { ensureCtx, execute, VOCAB } from './lib/actions.js'
import { buildEmployeePrompt } from './lib/prompt.js'
import { decide, activeBrain } from './lib/brain.js'
import { writeLedger } from './lib/ledger.js'
import { getToken } from './lib/api.js'

const TICK_MS = Number(process.env.SIM_TICK_MS ?? 45_000)
const EMPLOYEES_PER_TICK = Number(process.env.SIM_PER_TICK ?? 2)
const SKIP_SLUGS = new Set(['ondrej.observer'])

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const pickSlugs = (slugs: string[], n: number): string[] => {
  const shuffled = [...slugs].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, Math.min(n, shuffled.length))
}

const runOnce = async (slug: string): Promise<void> => {
  const ctx = await ensureCtx(slug).catch((err) => {
    writeLedger(slug, 'auth.error', 'fail', err instanceof Error ? err.message : String(err))
    return null
  })
  if (!ctx) return
  const prompt = await buildEmployeePrompt(slug, ctx.token, VOCAB)
  let decision
  try {
    decision = await decide(prompt)
  } catch (err) {
    writeLedger(slug, 'brain.error', 'fail', err instanceof Error ? err.message : String(err))
    return
  }
  writeLedger(slug, `decide.${decision.action}`, 'note', decision.rationale.slice(0, 160))
  const result = await execute(ctx, decision.action, decision.args ?? {})
  writeLedger(slug, decision.action, result.status, result.detail)
}

const warmTokens = async (slugs: string[]): Promise<void> => {
  for (const slug of slugs) {
    try {
      await getToken(slug)
      console.log(`[warm] ok ${slug}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[warm] skip ${slug}: ${msg.slice(0, 80)}`)
      writeLedger(slug, 'warm.fail', 'fail', msg.slice(0, 160))
    }
    await sleep(8_000)
  }
}

const main = async (): Promise<void> => {
  const all = allEmployees()
    .map((e) => e.slug)
    .filter((s) => !SKIP_SLUGS.has(s))
  console.log(`[run] starting forever-loop`)
  console.log(`[run] brain: ${activeBrain()}`)
  console.log(`[run] roster (${all.length}): ${all.join(', ')}`)
  console.log(`[run] tick=${TICK_MS}ms, per-tick=${EMPLOYEES_PER_TICK}`)
  writeLedger('orchestrator', 'loop.start', 'note', `brain=${activeBrain()} tick=${TICK_MS}ms`)
  await warmTokens(all)
  let tick = 0
  while (true) {
    tick += 1
    const picks = pickSlugs(all, EMPLOYEES_PER_TICK)
    console.log(`[run] tick=${tick} picks=${picks.join(',')}`)
    await Promise.allSettled(picks.map((slug) => runOnce(slug)))
    await sleep(TICK_MS)
  }
}

main().catch((err) => {
  writeLedger('orchestrator', 'loop.crash', 'fail', err instanceof Error ? err.message : String(err))
  console.error('[run] fatal', err)
  process.exit(1)
})
