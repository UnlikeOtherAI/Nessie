import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LEDGER_PATH = resolve(__dirname, '../../docs/simulation/ledger.md')
const PERSONAS_PATH = resolve(__dirname, '../personas.json')

type Personas = {
  company: string
  boss: { slug: string; displayName: string; role: string }
  observer: { slug: string; displayName: string; role: string }
  employees: { slug: string; displayName: string; department?: string; role: string }[]
}

let personasCache: Personas | null = null
const loadPersonas = (): Personas => {
  if (personasCache) return personasCache
  personasCache = JSON.parse(readFileSync(PERSONAS_PATH, 'utf8')) as Personas
  return personasCache
}

export const personaFor = (slug: string): { displayName: string; role: string; department?: string } => {
  const p = loadPersonas()
  if (p.boss.slug === slug) return { displayName: p.boss.displayName, role: p.boss.role }
  if (p.observer.slug === slug) return { displayName: p.observer.displayName, role: p.observer.role }
  const e = p.employees.find((x) => x.slug === slug)
  if (!e) throw new Error(`persona missing for slug=${slug}`)
  return { displayName: e.displayName, role: e.role, department: e.department }
}

export const orgRoster = (): string => {
  const p = loadPersonas()
  const rows = [
    `- ${p.boss.slug} — ${p.boss.displayName} (Boss). ${p.boss.role}`,
    ...p.employees.map((e) => `- ${e.slug} — ${e.displayName}${e.department ? ` [${e.department}]` : ''}. ${e.role}`),
  ]
  return rows.join('\n')
}

const tailLedger = (n: number, filterSlug?: string): string => {
  if (!existsSync(LEDGER_PATH)) return '(ledger empty)'
  const raw = readFileSync(LEDGER_PATH, 'utf8').split('\n')
  const dataLines = raw.filter((l) => l && !l.startsWith('#') && !l.startsWith('|'))
  const filtered = filterSlug ? dataLines.filter((l) => l.includes(`  ${filterSlug.padEnd(18)}  `)) : dataLines
  return filtered.slice(-n).join('\n') || '(no recent activity)'
}

export const buildEmployeePrompt = (
  slug: string,
  vocab: string[],
  globalTail = 8,
  selfTail = 5,
): string => {
  const persona = personaFor(slug)
  const recentGlobal = tailLedger(globalTail)
  const recentSelf = tailLedger(selfTail, slug)
  return [
    `You are ${persona.displayName} (slug: ${slug}).`,
    `Role: ${persona.role}`,
    persona.department ? `Department: ${persona.department}` : '',
    '',
    'Company roster (use slugs for `target_slug`):',
    orgRoster(),
    '',
    'Recent company activity (latest at bottom):',
    recentGlobal,
    '',
    'Recent actions you (or others on your behalf) have taken:',
    recentSelf,
    '',
    'Available actions (pick ONE):',
    `- idle { rationale }`,
    `- note { text }                                       — record a thought, do nothing externally`,
    `- dm_coworker { target_slug, content }                — direct-message a coworker`,
    `- post_in_channel { channel, content }                — post in named channel (default "General")`,
    `- create_agent { name, role, system_prompt, model }   — create a personal Nessie agent`,
    `- bind_agent { agent_name, channel }                  — bind your agent to a channel`,
    `- prompt_own_agent { agent_name, content }            — message your bound agent`,
    `- create_workflow { name, description, definition }   — author a workflow template`,
    `- bootstrap_pa {}                                     — initialise your personal assistant`,
    `- schedule_for_boss { content }                       — assistant only: route to boss`,
    '',
    `Vocabulary keys exposed: ${vocab.join(', ')}.`,
    '',
    'Stay in character. Prefer actions that move your role forward, talk to coworkers, build agents, set up workflows. Drew (assistant) should schedule for boss + nudge employees. The boss (alex.boss) should give direction and ask for status.',
    'Reply with one JSON object only: { "action": "...", "args": { ... }, "rationale": "one short sentence in character" }.',
  ]
    .filter(Boolean)
    .join('\n')
}
