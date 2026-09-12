import type { FastifyInstance, FastifyReply } from 'fastify'
import type { CredentialStore } from '@nessie/dashboard'

import {
  captureUndrivenSessionTabs,
  isCloudBrowserError,
  loadAgentBrowserLoginStatus,
  listAgentBrowserTabs,
  releaseCloudBrowserSession,
  resumeAgentBrowser,
  viewerMaySeeAgentBrowser,
} from '@nessie/browser-cloud'
import { createMcpSecretResolver } from '@nessie/mcp-manage'
import { BROWSER_OPEN_TOOL_ID, isExplicitToolGranted } from '@nessie/runtime'

import {
  AgentBrowserTabsResponseSchema,
  ResumeAgentBrowserResponseSchema,
} from '../contracts/browser-cloud.js'
import { createApiResponse, sendApiError } from '../lib/api.js'
import { AgentCardResponseError, respondToAgentCard } from '../services/agent-card-response.js'
import {
  findBrowserLoginCardForViewer,
  findTemporaryBrowserLoginCardForViewer,
} from '../services/browser-login-card-selection.js'
import {
  agentHasBrowserOpenGrant,
  agentInThread,
  browserScopeFor,
  loadViewableSession,
  originOf,
} from './browser-cloud-access.js'
import type { BrowserSessionOperations } from './browser-cloud-session-operations.js'
import type { RouteDeps } from './types.js'

type SendCloudBrowserError = (reply: FastifyReply, error: unknown) => boolean

export const registerBrowserCloudAgentSessionRoutes = (
  app: FastifyInstance,
  input: {
    deps: RouteDeps & { dashboardCredentials: CredentialStore }
    operations: BrowserSessionOperations
    secretResolver: ReturnType<typeof createMcpSecretResolver>
    sendCloudBrowserError: SendCloudBrowserError
  },
): void => {
  const { deps, operations, secretResolver, sendCloudBrowserError } = input
  const { prisma, authSecret, requireActorContext, requireUserActor } = deps

/**
 * The tabs the agent's browser was last seen with — the chat's Browser column
 * when nothing is live. Readable by whoever can read the conversation the
 * agent is in, which is the audience its browser already belongs to.
 */
app.get('/api/threads/:threadId/agents/:agentId/browser/tabs', async (request, reply) => {
  const actorContext = requireActorContext(request, reply)
  if (!actorContext) return reply

  const { threadId, agentId } = request.params as { threadId: string; agentId: string }
  const organizationId = actorContext.tenant.organizationId
  const reach = await agentInThread(prisma, {
    organizationId,
    threadId,
    agentId,
    userId: actorContext.actor.actorId,
  })
  if (!reach || !(await agentHasBrowserOpenGrant(prisma, { agentId, organizationId }))) {
    sendApiError(reply, 404, 'AGENT_NOT_FOUND', 'Agent not found')
    return reply
  }
  const scope = await browserScopeFor(prisma, {
    organizationId,
    agentId,
    viewerId: actorContext.actor.actorId,
  })
  const browser = scope && await prisma.agentBrowser.findFirst({
    where: { organizationId, agentId, status: 'active', ...scope },
    select: { id: true },
  })
  if (!browser) {
    return createApiResponse(AgentBrowserTabsResponseSchema.parse({ hasBrowser: false, quarantined: false, tabs: [] }))
  }
  const loginStatus = await loadAgentBrowserLoginStatus(prisma, browser.id)
  if (!loginStatus?.permitsSensitiveUse) {
    return createApiResponse(AgentBrowserTabsResponseSchema.parse({ hasBrowser: true, quarantined: true, tabs: [] }))
  }
  const tabs = await listAgentBrowserTabs(prisma, { organizationId, agentBrowserId: browser.id })
  // A picture of a signed-in page is that person's material, exactly as the
  // live view of it is. Someone outside the audience still learns where the
  // browser is — the site, not the page — and never what it showed.
  const allowed = await viewerMaySeeAgentBrowser(prisma, {
    agentBrowserId: browser.id,
    viewerId: actorContext.actor.actorId,
  })
  const visible = allowed
    ? tabs
    : tabs.map((tab) => ({
      ...tab,
      url: originOf(tab.url),
      screenshotDataUrl: null,
    }))
  return createApiResponse(AgentBrowserTabsResponseSchema.parse({
    hasBrowser: true, quarantined: false, tabs: visible,
  }))
})

/**
 * Bring the agent's browser back, for a person, the way it was left.
 *
 * Bills the connection the agent's browser already lives on, never the
 * resumer's own; lives on the idle TTL and is extended while the column is
 * open. While it is up the agent's own `browser_open` is refused as "open in
 * another run", which is the one-live-session-per-browser rule doing its job.
 */
app.post(
  "/api/threads/:threadId/agents/:agentId/browser/resume",
  async (request, reply) => {
    const actorContext = requireActorContext(request, reply);
    if (!actorContext) return reply;
    if (!requireUserActor(actorContext, reply)) return reply;

    const { threadId, agentId } = request.params as {
      threadId: string;
      agentId: string;
    };
    const organizationId = actorContext.tenant.organizationId;
    const reach = await agentInThread(prisma, {
      organizationId,
      threadId,
      agentId,
      userId: actorContext.actor.actorId,
    });
    if (!reach) {
      sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent not found");
      return reply;
    }
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, organizationId },
      select: { visibility: true, ownerUserId: true, toolPolicy: true },
    });
    if (!agent) {
      sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent not found");
      return reply;
    }
    if (!isExplicitToolGranted(agent.toolPolicy, BROWSER_OPEN_TOOL_ID)) {
      sendApiError(reply, 404, 'AGENT_BROWSER_NOT_ENABLED', 'Browser access is not enabled for this agent.')
      return reply
    }
    // Picking the browser up is seeing everything it is signed in to, so it
    // takes the same audience as watching it. A browser nobody signed in is
    // anyone's to open.
    const resumeScope = await browserScopeFor(prisma, {
      organizationId,
      agentId,
      viewerId: actorContext.actor.actorId,
    });
    const existing =
      resumeScope &&
      (await prisma.agentBrowser.findFirst({
        where: { organizationId, agentId, status: "active", ...resumeScope },
        select: { connection: { select: { scope: true, userId: true } }, id: true },
      }));
    if (existing) {
      const loginStatus = await loadAgentBrowserLoginStatus(prisma, existing.id)
      if (!loginStatus?.permitsSensitiveUse) {
        sendApiError(
          reply,
          409,
          'AGENT_BROWSER_QUARANTINED',
          'This shared browser may contain a personal sign-in. Reset it before opening a browser for this agent.',
        )
        return reply
      }
      const allowed = await viewerMaySeeAgentBrowser(prisma, {
        agentBrowserId: existing.id,
        viewerId: actorContext.actor.actorId,
      });
      if (!allowed) {
        sendApiError(
          reply,
          403,
          "AGENT_BROWSER_SIGNED_IN_BY_OTHERS",
          "This browser is signed in by someone else, so only they can open it.",
        );
        return reply;
      }
    }

    try {
      const resumed = await resumeAgentBrowser(
        {
          prisma,
          resolveSecret: (ref) => secretResolver.resolve(ref),
          encryptionSecret: encryptionKeyRing,
        },
        {
          organizationId,
          agentId,
          agentVisibility:
            agent.visibility === "private" ? "private" : "team",
          agentOwnerUserId: agent.ownerUserId ?? null,
          threadId,
          teamId: reach.teamId,
          // A browser with nothing to restore is one opening for the first
          // time; it lands on the home page in force for this person here
          // rather than on a blank page nobody can do anything with.
          homepage: await operations.homepageFor({
            organizationId,
            threadId,
            userId: actorContext.actor.actorId,
          }),
          userId: actorContext.actor.actorId,
        },
      );
      return createApiResponse(
        ResumeAgentBrowserResponseSchema.parse(resumed),
      );
    } catch (error) {
      // The lifecycle's sentence for this is written for the model ("wait for
      // the run … open a throwaway browser"); a person gets their own.
      if (
        isCloudBrowserError(error) &&
        error.code === "CLOUD_BROWSER_SESSION_ALREADY_OPEN"
      ) {
        sendApiError(
          reply,
          409,
          error.code,
          "This agent is using its browser right now. Wait for it to finish, then try again.",
        );
        return reply;
      }
      if (
        isCloudBrowserError(error) &&
        (error.code === "CLOUD_BROWSER_NO_CONNECTION" ||
          error.code === "CLOUD_BROWSER_AUTH_FAILED")
      ) {
        const owner = actorContext.actor.roles?.includes("owner") ?? false;
        const recovery = existing?.connection.scope === 'user'
          && existing.connection.userId === actorContext.actor.actorId
          ? {
              href: "/settings/account?tab=agents",
              label: "Connect Browserbase",
            }
          : existing?.connection.scope === 'organization' && owner
            ? {
                href: "/settings/organization?tab=agents",
                label: "Reconnect Browserbase",
              }
            : !existing && (agent.visibility === 'private'
              || (resumeScope !== null && resumeScope.principalUserId !== null))
              ? { href: '/settings/account?tab=agents', label: 'Connect Browserbase' }
            : !existing && owner
              ? { href: '/settings/organization?tab=agents', label: 'Connect Browserbase' }
            : null;
        sendApiError(reply, 409, error.code, error.message, undefined, {
          recovery: recovery ?? {
            message:
              "Ask an organisation owner to connect or reconnect Browserbase.",
          },
        });
        return reply;
      }
      if (sendCloudBrowserError(reply, error)) return reply;
      throw error;
    }
  },
);

/**
 * "I'm done" on a resumed session: the last state is written and the
 * browser stops billing now, rather than when the idle window closes it.
 * Only for a session a person opened — a run's session is its run's to end.
 */
app.delete("/api/browser-sessions/:sessionId", async (request, reply) => {
  const actorContext = requireActorContext(request, reply);
  if (!actorContext) return reply;
  if (!requireUserActor(actorContext, reply)) return reply;

  const { sessionId } = request.params as { sessionId: string };
  const session = await loadViewableSession(prisma, { actorContext, sessionId });
  if (!session || session.runId !== null) {
    sendApiError(
      reply,
      404,
      "CLOUD_BROWSER_SESSION_NOT_FOUND",
      "Session not found",
    );
    return reply;
  }

  // A matching login card owns its suspended run. Resolve it through the
  // same conditional card press as the card button: one response message,
  // one resolution and one resume, whichever door wins first.
  if (session.agentBrowserId || session.personalAccess) {
    const card = session.personalAccess
      ? await findTemporaryBrowserLoginCardForViewer(prisma, {
        organizationId: actorContext.tenant.organizationId,
        sessionId,
        threadId: session.threadId,
        userId: actorContext.actor.actorId,
      })
      : await findBrowserLoginCardForViewer(prisma, {
        agentBrowserId: session.agentBrowserId!,
        organizationId: actorContext.tenant.organizationId,
        threadId: session.threadId,
        userId: actorContext.actor.actorId,
      });
    if (card) {
      try {
        await respondToAgentCard(deps, {
          actionKey: "done",
          actorContext,
          card,
          handoverSessionId: sessionId,
        });
        // The resumed worker owns its capture. Do not dial CDP after it can
        // adopt this live session.
        return reply.code(204).send();
      } catch (error) {
        // The other door won the card/session race. Its transaction already
        // released control and resumed the parked run.
        if (
          error instanceof AgentCardResponseError
          && error.code === "CARD_NOT_OPEN"
        ) return reply.code(204).send();
        throw error;
      }
    }
  }

  // A generic viewer Done has no parked login card. A stale control claim is
  // not this user's page to capture or wake over.
  if (session.viewerMode !== 'controller')
    return reply.code(204).send();
  // Capture while this user still owns the session, then close it. A generic
  // viewer Done is never a login handover: waking the agent here leaked a
  // billed browser and could resume it into a person's partial sign-in.
  await captureUndrivenSessionTabs(prisma, {
    sessionId,
    encryptionSecret: encryptionKeyRing,
  });
  await releaseCloudBrowserSession({
    prisma,
    encryptionSecret: encryptionKeyRing,
    resolveSecret: (ref) => secretResolver.resolve(ref),
  }, {
    releasedBy: 'viewer_done',
    sessionId,
    // The authenticated capture above ran while the controller still owned
    // the capability; repeating it during release would race the close.
    skipCapture: true,
  });
  return reply.code(204).send();
});

}
