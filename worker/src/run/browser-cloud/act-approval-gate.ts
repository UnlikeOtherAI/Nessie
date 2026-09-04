import { currentPageUrl, findLiveSessionForRun } from '@nessie/browser-cloud'
import { BROWSER_ACT_TOOL_ID } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'
import { ExecutorBrowserActArgumentsSchema } from '@nessie/schemas'

import type { RunContext } from '../execute/types.js'
import { evaluateOriginGate, noteVisitedOrigin } from './origin-gate.js'
import { acquireCdp, originGateFor } from './session-pool.js'

/**
 * The cross-origin write gate, as an approval rather than a refusal.
 *
 * Refusing outright was safer but wrong in one common case: an agent signed
 * in to one service, asked to carry something into a form on another ("find
 * the invoice number in my mail, put it in the vendor portal"). That is a real
 * task, and only the person can say whether this particular one is theirs.
 *
 * So the ask is narrow — a write, on an origin this browser is not signed in
 * to, after it has visited one that it is — and everything else passes
 * without a prompt. Returning `{outcome:'allow'}` still *claims* the decision,
 * which keeps `browser_act` off the send-as-you standing-consent path that
 * has nothing to do with browsers.
 */
export const buildBrowserActApprovalHook = (
  prisma: PrismaClient,
  context: RunContext,
) =>
  async (input: { toolName: string; args: Record<string, unknown> }) => {
    if (input.toolName !== BROWSER_ACT_TOOL_ID) return null

    const parsed = ExecutorBrowserActArgumentsSchema.safeParse(input.args)
    if (!parsed.success) return { outcome: 'allow' as const }

    const session = await findLiveSessionForRun(prisma, context.run.id)
    if (!session) return { outcome: 'allow' as const }

    // No pooled state means this worker cannot drive the session at all, so
    // there is nothing to gate — the handler will say the connection is lost.
    const gate = originGateFor(session.id)
    if (!gate) return { outcome: 'allow' as const }

    // Asked, not remembered: a page can redirect itself between two tool
    // calls, and a gate keyed on the last URL *we* navigated to would judge
    // an attacker's origin to be the signed-in one. Falls back to the cached
    // value only if the browser cannot answer.
    const cdp = await acquireCdp(session.id).catch(() => null)
    const liveUrl = cdp ? await currentPageUrl(cdp) : null
    const url = liveUrl ?? gate.currentUrl
    if (!url) return { outcome: 'allow' as const }
    if (liveUrl) noteVisitedOrigin(gate, liveUrl)

    const verdict = evaluateOriginGate(gate, url, parsed.data)
    if (verdict.allowed) return { outcome: 'allow' as const }

    return {
      outcome: 'approval' as const,
      reason: verdict.reason,
      // Address-free, like the mail gate's: an origin names a site, never a
      // person's page content, and the approvals surface is read by owners.
      contextExtra: {
        browserAction: parsed.data.action,
        targetOrigin: new URL(url).origin,
      },
      // The person whose ask started the run is the one who can say whether
      // this crossing is part of what they wanted.
      requiredApproverUserId: context.run.principalUserId ?? null,
    }
  }
