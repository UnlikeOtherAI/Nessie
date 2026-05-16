import { allEmployees, getCredentials } from './employee.js'
import {
  bindAgent,
  bootstrapPersonalAssistant,
  createAgent,
  createChannel,
  createDmChannel,
  createWorkflow,
  getToken,
  invalidateToken,
  listAgents,
  listChannels,
  listUsers,
  postMessage,
} from './api.js'

export type ActionContext = {
  slug: string
  token: string
  userId: string
}

export type ActionResult = {
  status: 'ok' | 'fail'
  detail: string
}

export type ActionFn = (ctx: ActionContext, args: Record<string, unknown>) => Promise<ActionResult>

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

const fuzzyFindByName = <T extends { name: string }>(items: T[], needle: string): T | undefined => {
  if (!needle) return undefined
  const n = needle.toLowerCase()
  return (
    items.find((x) => x.name.toLowerCase() === n) ??
    items.find((x) => x.name.toLowerCase().includes(n)) ??
    items.find((x) => n.includes(x.name.toLowerCase()))
  )
}

const fuzzyFindByLabel = <T extends { label: string }>(items: T[], needle: string): T | undefined => {
  if (!needle) return undefined
  const n = needle.toLowerCase()
  return (
    items.find((x) => x.label.toLowerCase() === n) ??
    items.find((x) => x.label.toLowerCase().includes(n)) ??
    items.find((x) => n.includes(x.label.toLowerCase()))
  )
}

const resolveTargetUserId = async (ctx: ActionContext, args: Record<string, unknown>): Promise<string | null> => {
  const slug = str(args.target_slug ?? args.targetSlug ?? args.to)
  if (slug) {
    const peer = getCredentials(slug)
    if (peer.userId) return peer.userId
  }
  const email = str(args.target_email ?? args.email)
  if (email) {
    const users = await listUsers(ctx.token)
    const u = users.find((x) => x.email === email)
    if (u) return u.id
  }
  return null
}

const actions: Record<string, ActionFn> = {
  idle: async (_ctx, args) => ({ status: 'ok', detail: str(args.rationale, 'idle') }),

  note: async (_ctx, args) => ({ status: 'ok', detail: str(args.text ?? args.message, 'note') }),

  dm_coworker: async (ctx, args) => {
    const targetUserId = await resolveTargetUserId(ctx, args)
    if (!targetUserId) return { status: 'fail', detail: `no target user (args=${JSON.stringify(args).slice(0, 120)})` }
    const content = str(args.content ?? args.message)
    if (!content) return { status: 'fail', detail: 'no content' }
    const dm = await createDmChannel(ctx.token, targetUserId)
    await postMessage(ctx.token, dm.defaultThreadId, content)
    return { status: 'ok', detail: `dm→${targetUserId.slice(0, 8)} "${content.slice(0, 80)}"` }
  },

  post_in_channel: async (ctx, args) => {
    const label = str(args.channel ?? args.channel_label ?? args.label).replace(/^#/, '')
    const content = str(args.content ?? args.message)
    if (!content) return { status: 'fail', detail: 'no content' }
    const channels = await listChannels(ctx.token)
    const target = label ? fuzzyFindByLabel(channels, label) : channels.find((c) => c.label === 'General')
    const fallback = target ?? channels.find((c) => c.label === 'General')
    if (!fallback) return { status: 'fail', detail: `no channels available` }
    await postMessage(ctx.token, fallback.defaultThreadId, content)
    return { status: 'ok', detail: `#${fallback.label} "${content.slice(0, 80)}"` }
  },

  create_agent: async (ctx, args) => {
    const name = str(args.name)
    if (!name) return { status: 'fail', detail: 'no name' }
    const agents = await listAgents(ctx.token)
    const existing = fuzzyFindByName(agents, name)
    if (existing) return { status: 'ok', detail: `agent exists: ${existing.id.slice(0, 8)} "${existing.name}"` }
    const agent = await createAgent(ctx.token, {
      name,
      role: str(args.role, 'assistant'),
      systemPrompt: str(args.system_prompt ?? args.systemPrompt),
      provider: str(args.provider, 'openai'),
      model: str(args.model, 'gpt-4o-mini'),
    })
    return { status: 'ok', detail: `created agent ${agent.id.slice(0, 8)} "${name}"` }
  },

  bind_agent: async (ctx, args) => {
    const name = str(args.agent_name ?? args.agentName ?? args.name).replace(/^#/, '')
    const channelLabel = str(args.channel ?? args.channel_label, 'General').replace(/^#/, '')
    const agents = await listAgents(ctx.token)
    const agent = fuzzyFindByName(agents, name)
    if (!agent) return { status: 'fail', detail: `agent not found: ${name}` }
    const channels = (await listChannels(ctx.token)).filter((c) => c.type === 'standard' && !c.systemChannelType)
    const general = channels.find((c) => c.label === 'General')
    const wanted = fuzzyFindByLabel(channels, channelLabel) ?? general
    if (!wanted) return { status: 'fail', detail: `no bindable channel found` }
    if (agent.channelIds.includes(wanted.id)) {
      return { status: 'ok', detail: `${agent.name} already bound to #${wanted.label}` }
    }
    try {
      await bindAgent(ctx.token, agent.id, wanted.id)
      return { status: 'ok', detail: `bound ${agent.name} → #${wanted.label}` }
    } catch (err) {
      if (general && agent.channelIds.includes(general.id)) {
        return { status: 'ok', detail: `${agent.name} already bound to #General (couldn't bind #${wanted.label})` }
      }
      if (general && general.id !== wanted.id) {
        await bindAgent(ctx.token, agent.id, general.id)
        return { status: 'ok', detail: `bound ${agent.name} → #General (fallback from #${wanted.label})` }
      }
      throw err
    }
  },

  create_channel: async (ctx, args) => {
    const label = str(args.label ?? args.name ?? args.channel).replace(/^#/, '')
    if (!label) return { status: 'fail', detail: 'no label' }
    const channels = await listChannels(ctx.token)
    const existing = channels.find((c) => c.label.toLowerCase() === label.toLowerCase())
    if (existing) return { status: 'ok', detail: `channel exists: ${existing.id.slice(0, 8)} #${label}` }
    const ch = await createChannel(ctx.token, {
      label,
      visibility: (str(args.visibility) === 'private' ? 'private' : str(args.visibility) === 'protected' ? 'protected' : 'public') as 'public' | 'protected' | 'private',
    })
    return { status: 'ok', detail: `created #${label} ${ch.id.slice(0, 8)}` }
  },

  prompt_own_agent: async (ctx, args) => {
    const name = str(args.agent_name ?? args.agentName ?? args.name).replace(/^#/, '')
    const content = str(args.content ?? args.message)
    if (!content) return { status: 'fail', detail: 'no content' }
    const agents = await listAgents(ctx.token)
    const agent = fuzzyFindByName(agents, name)
    if (!agent) return { status: 'fail', detail: `agent not found: ${name}` }
    const channels = await listChannels(ctx.token)
    let target = channels.find((c) => agent.channelIds.includes(c.id))
    if (!target) {
      const general = channels.find((c) => c.label === 'General')
      if (!general) return { status: 'fail', detail: `no General channel to auto-bind to` }
      await bindAgent(ctx.token, agent.id, general.id)
      target = general
    }
    await postMessage(ctx.token, target.defaultThreadId, content)
    return { status: 'ok', detail: `→${agent.name} via #${target.label} "${content.slice(0, 60)}"` }
  },

  create_workflow: async (ctx, args) => {
    const name = str(args.name)
    if (!name) return { status: 'fail', detail: 'no name' }
    const wf = await createWorkflow(ctx.token, {
      name,
      description: str(args.description),
      definition: args.definition ?? { steps: [] },
    })
    return { status: 'ok', detail: `created workflow ${wf.id.slice(0, 8)} "${name}"` }
  },

  bootstrap_pa: async (ctx) => {
    await bootstrapPersonalAssistant(ctx.token)
    return { status: 'ok', detail: 'personal assistant ready' }
  },

  schedule_for_boss: async (ctx, args) => {
    const bossCreds = getCredentials('alex.boss')
    if (!bossCreds.userId) return { status: 'fail', detail: 'boss userId missing' }
    const content = str(args.content ?? args.message)
    if (!content) return { status: 'fail', detail: 'no content' }
    const dm = await createDmChannel(ctx.token, bossCreds.userId)
    const prefix = `[scheduled by ${ctx.slug}] `
    await postMessage(ctx.token, dm.defaultThreadId, `${prefix}${content}`)
    return { status: 'ok', detail: `scheduled→boss "${content.slice(0, 80)}"` }
  },
}

export const VOCAB = Object.keys(actions)

export const execute = async (ctx: ActionContext, action: string, args: Record<string, unknown>): Promise<ActionResult> => {
  const fn = actions[action]
  if (!fn) return { status: 'fail', detail: `unknown action: ${action}` }
  try {
    return await fn(ctx, args)
  } catch (err) {
    return { status: 'fail', detail: err instanceof Error ? err.message : String(err) }
  }
}

export const ensureCtx = async (slug: string): Promise<ActionContext> => {
  try {
    const { token, userId } = await getToken(slug)
    return { slug, token, userId }
  } catch (err) {
    invalidateToken(slug)
    const { token, userId } = await getToken(slug)
    return { slug, token, userId }
  }
}

export const peerSlugs = (exceptSlug: string): string[] =>
  allEmployees()
    .filter((e) => e.slug !== exceptSlug && e.slug !== 'ondrej.observer')
    .map((e) => e.slug)
