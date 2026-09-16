import { randomUUID } from 'node:crypto'

import {
  SHEET_READ_TOOL_IDS,
  canReadSpace,
  canWriteSpace,
  runSheetPageTool,
  spreadsheetClientOpId,
  toSheetToolRefusal,
  type SheetToolId,
  type SpreadsheetWriteActor,
} from '@nessie/knowledge'
import { attributionFromActorContext } from '@nessie/runtime'
import { z, type ZodTypeAny } from 'zod'

import { emitAuditEvent } from '../../services/audit.js'
import { requireScope } from '../scopes.js'
import type { McpToolContext, McpToolDefinition } from '../tool-context.js'

/**
 * What every `nessie_sheet_*` call does before it does anything: the scope, the
 * policy, the space, the actor and the audit stamp.
 *
 * Mirrored, not reimplemented: every one of these resolves access and then
 * calls the same `@nessie/knowledge` operation the worker's `sheet_*` builtin
 * calls. The only differences are the three that have to differ — who the actor
 * is (the granting human, with the credential recorded beside them), how access
 * is decided (the credential's scopes, then the same space predicates the HTTP
 * routes use), and how the answer travels.
 *
 * **No new scope.** A spreadsheet is a document, so it lives under
 * `documents_read` and `documents_write`. A person ticking "documents" at
 * pairing time is answering the question they think they are answering; a
 * separate `spreadsheets` scope would have split one decision into two and left
 * every existing credential silently unable to open a document kind that did
 * not exist when it was granted.
 *
 * **The scope is checked first, before anything reads a page, a space or a
 * batch summary.** That ordering is the point of the read-only test: a
 * credential that may not write is refused on the way in, not after the write
 * door has looked at what it claimed to be doing.
 *
 * Split from the definitions in `spreadsheets.ts` along the seam that matters:
 * everything here decides whether a call may happen, and everything there
 * describes what the call is. A reader checking "can a read-only credential
 * write?" should not have to scroll past twelve zod schemas to find out.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/agent-tools.md
 */

export const NOT_AVAILABLE = {
  error: 'Spreadsheets are not available on this deployment.',
} as const

/** One answer for "no such spreadsheet" and "not one this account can use." */
export const PAGE_UNREACHABLE = {
  error: 'Spreadsheet not found, or not one this account can use.',
} as const

export const SPACE_UNREACHABLE = {
  error: 'Space not found, or not one this account can use.',
} as const

/**
 * A caller-supplied idempotency key, defaulted to a fresh uuid.
 *
 * Defaulted rather than required because most calls are made once and a
 * required key is a required mistake. A paired agent that retries **without**
 * one double-applies its write, and the description says so in the words an
 * agent author will read.
 */
export const requestId = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(
    'Idempotency key. Retrying a write with the same requestId returns the change '
    + 'that already landed; retrying without one applies it twice.',
  )

export const pageId = z.string().uuid()
export const sheetName = z.string().max(200).optional()
export const range = z
  .string()
  .max(64)
  .optional()
  .describe('A1 range: "B2", "B2:D40", a whole column "B:D" or whole rows "3:7". Never sheet-qualified.')

export type SheetActor = {
  actor: SpreadsheetWriteActor
  attribution: ReturnType<typeof attributionFromActorContext>
  clientOpId: string
}

/**
 * The credential resolves as the person who approved it — that is what an
 * agent credential means — so the journal records the human and stamps the
 * credential beside them. Without `agentCredentialId` the history could not
 * tell a person's own edit from one their agent made on their behalf.
 */
export const actorFor = async (
  context: McpToolContext,
  input: { requestId?: unknown },
): Promise<SheetActor> => {
  const actorId = context.actorContext.actor.actorId
  const user = await context.prisma.user.findUnique({
    where: { id: actorId },
    select: { displayName: true },
  })
  return {
    actor: {
      type: 'user',
      id: actorId,
      displayName: user?.displayName ?? 'Someone',
      ...(context.actorContext.actionContext.agentCredentialId
        ? { agentCredentialId: context.actorContext.actionContext.agentCredentialId }
        : {}),
    },
    attribution: attributionFromActorContext(context.actorContext),
    // A caller's `requestId` is free text, and the wire form a peer receives
    // requires a uuid; the derivation is deterministic, so retrying with the
    // same requestId is still recognised as the same write.
    clientOpId: spreadsheetClientOpId(
      typeof input.requestId === 'string' && input.requestId.trim()
        ? input.requestId.trim()
        : randomUUID(),
    ),
  }
}

/** Record that a spreadsheet change arrived through an agent credential. */
const auditSheetWrite = async (
  context: McpToolContext,
  pageIdentifier: string,
  metadata: Record<string, unknown>,
): Promise<void> => {
  await emitAuditEvent(context.prisma, {
    action: 'kb.page.updated',
    actorContext: context.actorContext,
    metadata: { ...metadata, via: 'mcp_agent_credential' },
    outcome: 'success',
    resourceId: pageIdentifier,
    resourceType: 'knowledge_page',
  })
}

/**
 * Open a spreadsheet for this credential, or say why not.
 *
 * The same two halves the HTTP route applies: the space grant, and every
 * retained version readable — the second is what stops an agent's private
 * material reaching somebody the conversation was never shared with.
 */
export const openPage = async (
  context: McpToolContext,
  identifier: string,
  mode: 'read' | 'write',
): Promise<{ page: { id: string; spaceId: string; title: string } } | { error: string }> => {
  const access = context.knowledge
  if (!access) return NOT_AVAILABLE
  const organizationId = context.actorContext.tenant.organizationId
  const page = await access.provider.getPage(organizationId, identifier)
  if (!page || page.kind !== 'spreadsheet') return PAGE_UNREACHABLE

  const space = await access.provider.getSpace(organizationId, page.spaceId)
  const viewer = await access.buildViewer(context.actorContext)
  if (!space || !canReadSpace(space, viewer)) return PAGE_UNREACHABLE
  if ((await access.filterReadablePages(viewer, [page])).length === 0) return PAGE_UNREACHABLE
  if (mode === 'write' && !canWriteSpace(space, viewer)) return PAGE_UNREACHABLE
  return { page }
}

export const pageTool = (
  name: string,
  toolId: SheetToolId,
  description: string,
  inputSchema: Record<string, ZodTypeAny>,
): McpToolDefinition => ({
  name,
  description,
  inputSchema: { pageId, ...inputSchema },
  run: async (context, input) => {
    const write = !SHEET_READ_TOOL_IDS.has(toolId)
    // First, and before anything looks at a page, a space or a summary.
    requireScope(context.scopes, write ? 'documents_write' : 'documents_read')
    const service = context.spreadsheet
    if (!service) return NOT_AVAILABLE

    if (write) {
      const decision = await context.checkPolicy(
        context.prisma,
        context.actorContext,
        'knowledge_page',
        'edit',
      )
      if (!decision.allowed) return { error: `Knowledge base access denied: ${decision.reasonCode}` }
    }

    const opened = await openPage(context, input.pageId as string, write ? 'write' : 'read')
    if ('error' in opened) return opened

    const who = await actorFor(context, input)
    try {
      const result = await runSheetPageTool(
        service,
        {
          organizationId: context.actorContext.tenant.organizationId,
          pageId: opened.page.id,
          ...who,
        },
        toolId,
        input,
      )
      if (write) await auditSheetWrite(context, opened.page.id, { tool: name })
      return result
    } catch (error) {
      const refusal = toSheetToolRefusal(error)
      if (!refusal) throw error
      return refusal
    }
  },
})
