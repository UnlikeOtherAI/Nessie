import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listAgents, listChannels } from './api.js'

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

export const buildEmployeePrompt = async (
  slug: string,
  token: string,
  vocab: string[],
  globalTail = 8,
  selfTail = 5,
): Promise<string> => {
  const persona = personaFor(slug)
  const recentGlobal = tailLedger(globalTail)
  const recentSelf = tailLedger(selfTail, slug)
  const [channels, agents] = await Promise.all([
    listChannels(token).catch(() => []),
    listAgents(token).catch(() => []),
  ])
  const standardChannels = channels.filter((c) => c.type === 'standard' && !c.systemChannelType)
  const channelLines = standardChannels.length
    ? standardChannels.map((c) => `  - #${c.label}`).join('\n')
    : '  (none — use create_channel to make one)'
  const agentLines = agents.length
    ? agents.map((a) => `  - ${a.name}${a.channelIds.length ? ` [in: ${a.channelIds.length} channel(s)]` : ' [unbound]'}`).join('\n')
    : '  (none)'
  return [
    `You are ${persona.displayName} (slug: ${slug}).`,
    `Role: ${persona.role}`,
    persona.department ? `Department: ${persona.department}` : '',
    '',
    'Company roster (use these slugs for `target_slug`):',
    orgRoster(),
    '',
    'Channels you can see (use EXACT labels for `channel`; create new ones with create_channel):',
    channelLines,
    '',
    'Agents currently visible (use EXACT names for `agent_name`):',
    agentLines,
    '',
    'Recent company activity (latest at bottom):',
    recentGlobal,
    '',
    'Recent actions you (or others on your behalf) have taken:',
    recentSelf,
    '',
    'Available actions (pick ONE):',
    `- idle { rationale }`,
    `- note { text }                                       — record a thought`,
    `- dm_coworker { target_slug, content }                — direct-message a coworker`,
    `- post_in_channel { channel, content }                — post in a channel from the list above`,
    `- create_channel { label, visibility }                — create a new channel`,
    `- create_agent { name, role, system_prompt, model }   — create a personal Nessie agent`,
    `- bind_agent { agent_name, channel }                  — bind your agent to a channel`,
    `- prompt_own_agent { agent_name, content }            — message your bound agent (auto-binds to General)`,
    `- create_workflow { name, description, definition }   — author a workflow template`,
    `- bootstrap_pa {}                                     — initialise your personal assistant`,
    `- schedule_for_boss { content }                       — assistant only: route to boss`,
    '',
    `Vocabulary keys exposed: ${vocab.join(', ')}.`,
    '',
    'Rules:',
    '- Only use channel labels and agent names from the lists above. If you want a channel that does not exist, call create_channel first.',
    '- Do NOT chase "channel binding issues" or apologise about prior failures — fix them with the correct action.',
    '- Stay in character. Move your role forward: build agents, write workflows, talk to coworkers about real work.',
    '- Drew schedules for boss + nudges employees. The boss gives direction and asks for status.',
    '',
    'Reply with one JSON object only: { "action": "...", "args": { ... }, "rationale": "one short sentence in character" }.',
  ]
    .filter(Boolean)
    .join('\n')
}
