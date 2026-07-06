import type { PrismaClient } from '@prisma/client'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { parseAgentId } from '@nessie/schemas'
import { createGrant } from './tool-grants.js'

const LIBRARIAN_AGENT_KIND = 'shared' as const
const LIBRARIAN_SURFACE_POLICY = 'shared' as const
const LIBRARIAN_DELEGATION_MODE = 'none' as const
const LIBRARIAN_ROLE = 'librarian'

export const LIBRARIAN_NAME = 'Librarian'

// Builtin tools the Librarian is granted at creation time. `toolPolicy` on the
// agent record only ever *denies* (see authorizeToolCall) — every tool below
// is also seeded/granted through the ToolRegistryEntry + ToolGrant tables so
// the agent's tool catalog reflects them explicitly, independent of the
// deny-only policy map.
const LIBRARIAN_TOOL_IDS = [
  'kb_search',
  'kb_page_read',
  'kb_list',
  'kb_draft_write',
  'kb_file',
  'kb_publish_request',
  'send_message',
] as const

const LIBRARIAN_TOOL_POLICY: Record<string, boolean> = Object.fromEntries(
  LIBRARIAN_TOOL_IDS.map((toolId) => [toolId, true]),
)

const LIBRARIAN_SYSTEM_PROMPT = `You are the Librarian, this organization's knowledge-base research agent.

Your job:
- Find and cite documents. Use kb_search to locate candidate pages, then
  kb_page_read to pull the full text of the ones that matter before you answer.
- Help people navigate spaces. Use kb_list (no spaceId) to see which spaces
  exist, and kb_list with a spaceId to see a space's page tree.
- Answer "where is X" / "what do we know about X" questions with citations:
  always name the page title and its pageId so the reader can open it.
- Never fabricate page contents. If kb_search finds nothing, say so plainly
  instead of guessing.
- You only see the spaces you have been granted access to. If a question
  touches a space you cannot read, say that plainly rather than assuming it
  does not exist.
- You may draft pages with kb_draft_write (a new page, or a new version of an
  existing one) and file your own drafts with kb_file (move, rename, or
  relabel them). Keep summaries accurate — never write a summary that claims
  more than the body supports.
- Always finish a drafting task by calling kb_publish_request and telling the
  human what you drafted and where (page title and pageId). A draft you never
  submit for review is unfinished work.
- You never publish anything yourself, and you must never claim a page is
  published. Publication happens only after a human approves your
  kb_publish_request — until then, say a page is "drafted" or "pending
  review," not "published."`

// Registry entries the grants below reference. Builtin tool registry rows are
// normally seeded lazily per-organization by the worker's first run
// (worker/src/run/execute/tool-registry.ts); ensureLibrarianAgent may run
// before that has ever happened for this org; so it upserts the handful of
// rows it needs itself, idempotently, using the exact same shape the worker
// seeds so the two never diverge into two different registry rows for the
// same tool.
const BUILTIN_REGISTRY_SCOPE_KEY = 'builtin'

const upsertBuiltinRegistryEntry = async (
  prisma: PrismaClient,
  organizationId: string,
  toolId: string,
): Promise<string> => {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.id === toolId)
  if (!definition) {
    throw new Error(`Unknown builtin tool id: ${toolId}`)
  }
  const entry = await prisma.toolRegistryEntry.upsert({
    where: {
      organizationId_scopeKey_toolId: {
        organizationId,
        scopeKey: BUILTIN_REGISTRY_SCOPE_KEY,
        toolId,
      },
    },
    create: {
      builtin: true,
      description: definition.description,
      overview: definition.description,
      enabled: true,
      handlerKind: 'builtin',
      label: definition.label,
      organizationId,
      scopeKey: BUILTIN_REGISTRY_SCOPE_KEY,
      safe: definition.safe,
      toolId,
    },
    update: {
      builtin: true,
      description: definition.description,
      handlerKind: 'builtin',
      label: definition.label,
      scopeKey: BUILTIN_REGISTRY_SCOPE_KEY,
      safe: definition.safe,
    },
    select: { id: true },
  })
  return entry.id
}

const grantLibrarianTools = async (
  prisma: PrismaClient,
  organizationId: string,
  agentId: string,
): Promise<void> => {
  for (const toolId of LIBRARIAN_TOOL_IDS) {
    const toolRegistryEntryId = await upsertBuiltinRegistryEntry(prisma, organizationId, toolId)
    await createGrant(prisma, {
      toolRegistryEntryId,
      organizationId,
      agentId,
      state: 'allowed',
    })
  }
}

const librarianAgentData = (organizationId: string) => ({
  agentKind: LIBRARIAN_AGENT_KIND,
  delegationMode: LIBRARIAN_DELEGATION_MODE,
  // Model/provider stay null: which model backs the Librarian is a per-org
  // cost/config decision (falls back to the org default), not something this
  // bootstrap should pin.
  model: null,
  name: LIBRARIAN_NAME,
  organizationId,
  provider: null,
  role: LIBRARIAN_ROLE,
  surfacePolicy: LIBRARIAN_SURFACE_POLICY,
  systemManaged: true,
  systemPrompt: LIBRARIAN_SYSTEM_PROMPT,
  toolPolicy: LIBRARIAN_TOOL_POLICY,
})

// Idempotently creates (or refreshes) the org's shared Librarian agent and
// grants it its read-only knowledge-base tool set. Mirrors
// ensurePersonalAssistantAgent's advisory-lock upsert-by-kind pattern.
export const ensureLibrarianAgent = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<string> => {
  const agentId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${organizationId}),
        hashtext('librarian_agent')
      )
    `

    const existing = await tx.agent.findFirst({
      where: {
        organizationId,
        agentKind: LIBRARIAN_AGENT_KIND,
        systemManaged: true,
        name: LIBRARIAN_NAME,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })

    if (existing) {
      const agent = await tx.agent.update({
        where: { id: existing.id },
        data: librarianAgentData(organizationId),
        select: { id: true },
      })
      return parseAgentId(agent.id)
    }

    const agent = await tx.agent.create({
      data: librarianAgentData(organizationId),
      select: { id: true },
    })
    return parseAgentId(agent.id)
  })

  await grantLibrarianTools(prisma, organizationId, agentId)

  return agentId
}
