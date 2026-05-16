import { allEmployees, getCredentials } from './employee.js'
import {
  bindAgent,
  bootstrapPersonalAssistant,
  createAgent,
  createDmChannel,
  createWorkflow,
  getToken,
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
    const label = str(args.channel ?? args.channel_label ?? args.label)
    const content = str(args.content ?? args.message)
    if (!content) return { status: 'fail', detail: 'no content' }
    const channels = await listChannels(ctx.token)
    const target = label
      ? channels.find((c) => c.label.toLowerCase() === label.toLowerCase()) ??
        channels.find((c) => c.label.toLowerCase().includes(label.toLowerCase()))
      : channels.find((c) => c.label === 'General')
    if (!target) return { status: 'fail', detail: `channel not found (label=${label})` }
    await postMessage(ctx.token, target.defaultThreadId, content)
    return { status: 'ok', detail: `#${target.label} "${content.slice(0, 80)}"` }
  },

  create_agent: async (ctx, args) => {
    const name = str(args.name)
    if (!name) return { status: 'fail', detail: 'no name' }
    const agents = await listAgents(ctx.token)
    const existing = agents.find((a) => a.name.toLowerCase() === name.toLowerCase())
    if (existing) return { status: 'ok', detail: `agent exists: ${existing.id.slice(0, 8)} ${name}` }
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
    const name = str(args.agent_name ?? args.agentName ?? args.name)
    const channelLabel = str(args.channel ?? args.channel_label, 'General')
    const agents = await listAgents(ctx.token)
    const agent = agents.find((a) => a.name.toLowerCase() === name.toLowerCase())
    if (!agent) return { status: 'fail', detail: `agent not found: ${name}` }
    const channels = await listChannels(ctx.token)
    const channel = channels.find((c) => c.label.toLowerCase() === channelLabel.toLowerCase())
    if (!channel) return { status: 'fail', detail: `channel not found: ${channelLabel}` }
    if (agent.channelIds.includes(channel.id)) {
      return { status: 'ok', detail: `${name} already bound to #${channel.label}` }
    }
    await bindAgent(ctx.token, agent.id, channel.id)
    return { status: 'ok', detail: `bound ${name} → #${channel.label}` }
  },

  prompt_own_agent: async (ctx, args) => {
    const name = str(args.agent_name ?? args.agentName ?? args.name)
    const content = str(args.content ?? args.message)
    if (!content) return { status: 'fail', detail: 'no content' }
    const agents = await listAgents(ctx.token)
    const agent = agents.find((a) => a.name.toLowerCase() === name.toLowerCase())
    if (!agent) return { status: 'fail', detail: `agent not found: ${name}` }
    if (agent.channelIds.length === 0) return { status: 'fail', detail: `${name} not bound to any channel` }
    const channels = await listChannels(ctx.token)
    const target = channels.find((c) => agent.channelIds.includes(c.id))
    if (!target) return { status: 'fail', detail: `agent channel not visible` }
    await postMessage(ctx.token, target.defaultThreadId, content)
    return { status: 'ok', detail: `→${name} via #${target.label} "${content.slice(0, 60)}"` }
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
  const { token, userId } = await getToken(slug)
  return { slug, token, userId }
}

export const peerSlugs = (exceptSlug: string): string[] =>
  allEmployees()
    .filter((e) => e.slug !== exceptSlug && e.slug !== 'ondrej.observer')
    .map((e) => e.slug)
