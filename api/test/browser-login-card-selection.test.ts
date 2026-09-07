import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";
import { AgentCardSpecSchema } from "@nessie/schemas";
import { BROWSER_OPEN_TOOL_ID } from "@nessie/runtime";
import Fastify from "fastify";
import { createRequestHelpers } from "../src/lib/request-helpers.js";

import {
  AgentCardResponseError,
  respondToAgentCard,
} from "../src/services/agent-card-response.js";
import { findBrowserLoginCardForViewer } from "../src/services/browser-login-card-selection.js";
import { registerBrowserCloudRoutes } from "../src/routes/browser-cloud.js";

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip;

runDatabaseTest(
  "viewer handover selects only its live generated done card",
  async (t) => {
    const prisma = new PrismaClient();
    const suffix = randomUUID();
    t.after(async () => {
      await prisma
        .$executeRaw`DELETE FROM queue_jobs WHERE payload->>'threadId' = ${thread.id}`
        .catch(() => undefined)
      await prisma.organization.deleteMany({
        where: { name: `handover-${suffix}` },
      });
      await prisma.user.deleteMany({ where: { email: { contains: suffix } } });
      await prisma.$disconnect();
    });
    const organization = await prisma.organization.create({
      data: { name: `handover-${suffix}` },
    });
    const project = await prisma.project.create({
      data: { name: `p-${suffix}`, organizationId: organization.id },
    });
    const team = await prisma.team.create({
      data: { name: `t-${suffix}`, projectId: project.id },
    });
    const channel = await prisma.channel.create({
      data: {
        label: `c-${suffix}`,
        slug: `handover-${suffix.slice(0, 8)}`,
        organizationId: organization.id,
        projectId: project.id,
        teamId: team.id,
        visibility: "public",
      },
    });
    const thread = await prisma.thread.create({
      data: { channelId: channel.id, title: "handover" },
    });
    const agent = await prisma.agent.create({
      data: {
        name: `a-${suffix}`,
        organizationId: organization.id,
        projectId: project.id,
        teamId: team.id,
        toolPolicy: { [BROWSER_OPEN_TOOL_ID]: true },
      },
    });
    await prisma.agentBinding.create({
      data: {
        agentId: agent.id,
        channelId: channel.id,
        principalUserId: null,
      },
    });
    const user = await prisma.user.create({
      data: {
        displayName: "responder",
        email: `handover-${suffix}@example.test`,
      },
    });
    const stranger = await prisma.user.create({
      data: {
        displayName: "stranger",
        email: `handover-stranger-${suffix}@example.test`,
      },
    });
    await prisma.organizationMember.createMany({
      data: [
        { organizationId: organization.id, role: "member", userId: user.id },
        {
          organizationId: organization.id,
          role: "member",
          userId: stranger.id,
        },
      ],
    });
    await prisma.agent.update({
      where: { id: agent.id },
      data: { ownerUserId: user.id, visibility: "private" },
    });
    await prisma.channel.update({
      where: { id: channel.id },
      data: {
        dmKey: `agent:${organization.id}:${user.id}:${agent.id}`,
        type: "dm",
        visibility: "private",
      },
    });
    await prisma.channelMember.createMany({
      data: [
        { channelId: channel.id, userId: user.id },
      ],
    });
    const message = await prisma.message.create({
      data: {
        agentId: agent.id,
        content: "Sign in",
        role: "assistant",
        threadId: thread.id,
      },
    });
    const run = await prisma.run.create({
      data: {
        agentId: agent.id,
        status: "waiting_input",
        threadId: thread.id,
        triggerMessageId: message.id,
      },
    });
    await prisma.runCheckpoint.create({
      data: {
        agentId: agent.id,
        note: "Sign-in required",
        organizationId: organization.id,
        reason: "waiting_input",
        runId: run.id,
        threadId: thread.id,
      },
    });
    const connection = await prisma.cloudBrowserConnection.create({
      data: {
        apiKeyRef: "secret_browserbase_test",
        createdByUserId: user.id,
        organizationId: organization.id,
        projectId: "test-project",
        scope: "organization",
      },
    });
    const browser = await prisma.agentBrowser.create({
      data: {
        agentId: agent.id,
        browserbaseContextId: `context-${suffix}`,
        connectionId: connection.id,
        organizationId: organization.id,
      },
    });
    const session = await prisma.cloudBrowserSession.create({
      data: {
        agentBrowserId: browser.id,
        agentId: agent.id,
        authenticated: true,
        browserbaseSessionId: `session-${suffix}`,
        connectionId: connection.id,
        controlledByUserId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
        interactionTransport: 'mediated',
        organizationId: organization.id,
        requestedByUserId: user.id,
        status: "active",
        threadId: thread.id,
      },
    });
    const card = await prisma.agentCard.create({
      data: {
        agentId: agent.id,
        browserLogin: { agentBrowserId: browser.id, service: "Example" },
        channelId: channel.id,
        messageId: message.id,
        organizationId: organization.id,
        respondentUserIds: [user.id],
        runId: run.id,
        spec: {
          schemaVersion: 1,
          title: "Sign in",
          blocks: [{ type: "text", markdown: "Sign in, then choose Done." }],
          actions: [
            { key: "done", label: "Done", style: "primary", submits: true },
          ],
        },
        resumeState: {
          actorContext: {
            actionContext: { requestId: `parked-${suffix}` },
            actor: { actorId: user.id, actorType: "user", roles: ["member"] },
            tenant: { organizationId: organization.id },
          },
          interactive: true,
          messageId: message.id,
        },
        status: "open",
        threadId: thread.id,
        waitRunId: run.id,
      },
    });
    const found = await findBrowserLoginCardForViewer(prisma, {
      agentBrowserId: browser.id,
      organizationId: organization.id,
      threadId: thread.id,
      userId: user.id,
    });
    assert.equal(AgentCardSpecSchema.safeParse(card.spec).success, true);
    assert.equal(found?.id, card.id);
    assert.equal(
      await findBrowserLoginCardForViewer(prisma, {
        agentBrowserId: browser.id,
        organizationId: organization.id,
        threadId: thread.id,
        userId: stranger.id,
      }),
      null,
    );
    const actorContext = {
      actionContext: { requestId: `handover-${suffix}` },
      actor: { actorId: user.id, actorType: "user", roles: ["member"] },
      tenant: { organizationId: organization.id },
    } as const;
    const deps = {
      ...createRequestHelpers(prisma),
      authSecret: "test-auth-secret",
      browserCloudClientFactory: () => ({}) as never,
      dashboardCredentials: {},
      mcpSecretStore: {},
      messageMemoryCaptureConfig: null,
      prisma,
      realtimeHub: { publishWs: async () => undefined },
    };
    const outcome = await respondToAgentCard(deps as never, {
      actionKey: "done",
      actorContext,
      card: found!,
      handoverSessionId: session.id,
    });
    assert.equal(outcome.status, "resolved");
    assert.equal(
      await prisma.run.count({ where: { continuationOfRunId: run.id } }),
      1,
      "the parked run has one continuation",
    );
    assert.equal(
      await prisma.agentCard
        .findUnique({
          select: { resumedByRunId: true },
          where: { id: card.id },
        })
        .then((row) => row?.resumedByRunId !== null),
      true,
      "the card records the one continuation it created",
    );
    assert.equal(
      await prisma.message.count({ where: { threadId: thread.id } }),
      2,
    );
    assert.equal(
      await prisma.agentBrowserLogin.count({
        where: { agentBrowserId: browser.id, userId: user.id },
      }),
      1,
    );
    assert.deepEqual(
      await prisma.cloudBrowserSession.findUnique({
        select: { controlledByUserId: true },
        where: { id: session.id },
      }),
      { controlledByUserId: null },
    );
    const ephemeral = await prisma.cloudBrowserSession.create({
      data: {
        agentId: agent.id,
        authenticated: true,
        connectionId: connection.id,
        expiresAt: new Date(Date.now() + 60_000),
        interactionTransport: 'mediated',
        organizationId: organization.id,
        requestedByUserId: user.id,
        status: "active",
        threadId: thread.id,
      },
    });
    const preLoginEphemeral = await prisma.cloudBrowserSession.create({
      data: {
        agentId: agent.id,
        authenticated: false,
        connectionId: connection.id,
        expiresAt: new Date(Date.now() + 60_000),
        interactionTransport: 'mediated',
        organizationId: organization.id,
        requestedByUserId: user.id,
        status: "active",
        threadId: thread.id,
      },
    });
    const strangerApp = Fastify();
    registerBrowserCloudRoutes(strangerApp, {
      ...deps,
      requireActorContext: () => ({
        actionContext: { requestId: `foreign-${suffix}` },
        actor: { actorId: stranger.id, actorType: "user", roles: ["member"] },
        tenant: { organizationId: organization.id },
      }),
      requireOwner: () => true,
      requireUserActor: () => true,
    } as never);
    const foreign = await strangerApp.inject({
      method: "DELETE",
      url: `/api/browser-sessions/${session.id}`,
    });
    assert.equal(
      foreign.statusCode,
      404,
      "a non-requester cannot complete a signed-in session",
    );
    assert.equal(
      (
        await strangerApp.inject({
          method: "GET",
          url: `/api/browser-sessions/${ephemeral.id}`,
        })
      ).statusCode,
      404,
      "an authenticated ephemeral session is requester-only",
    );
    assert.equal(
      (
        await strangerApp.inject({
          method: "POST",
          url: `/api/browser-sessions/${preLoginEphemeral.id}/control`,
        })
      ).statusCode,
      404,
      "a stranger cannot claim an ephemeral session before sign-in",
    );
    const requesterApp = Fastify();
    registerBrowserCloudRoutes(requesterApp, {
      ...deps,
      requireActorContext: () => actorContext,
      requireOwner: () => true,
      requireUserActor: () => true,
    } as never);
    assert.equal(
      (
        await requesterApp.inject({
          method: "GET",
          url: `/api/browser-sessions/${ephemeral.id}`,
        })
      ).statusCode,
      200,
      "the requester can read their ephemeral session",
    );
    assert.equal(
      (
        await requesterApp.inject({
          method: "POST",
          url: `/api/browser-sessions/${ephemeral.id}/control`,
        })
      ).statusCode,
      200,
      "the requester can take control before closing their manual session",
    );
    assert.equal(
      (
        await requesterApp.inject({
          method: "DELETE",
          url: `/api/browser-sessions/${ephemeral.id}`,
        })
      ).statusCode,
      204,
      "Done closes a manual session rather than handing it to an agent",
    );
    assert.deepEqual(
      await prisma.cloudBrowserSession.findUnique({
        select: { releasedBy: true, status: true },
        where: { id: ephemeral.id },
      }),
      { releasedBy: "viewer_done", status: "released" },
      "the provider lifecycle is released after the final authenticated capture",
    );
    assert.equal(
      (
        await requesterApp.inject({
          method: "POST",
          url: `/api/browser-sessions/${preLoginEphemeral.id}/control`,
        })
      ).statusCode,
      200,
      "the requester can claim the pre-login ephemeral controls",
    );
    assert.deepEqual(
      await prisma.cloudBrowserSession.findUnique({
        select: { controlledByUserId: true },
        where: { id: preLoginEphemeral.id },
      }),
      { controlledByUserId: user.id },
    );
    assert.equal(
      (
        await strangerApp.inject({
          method: "GET",
          url: `/api/browser-sessions/${preLoginEphemeral.id}`,
        })
      ).statusCode,
      404,
      "a human-controlled ephemeral session is requester-only before handback",
    );
    await prisma.agent.update({
      data: { toolPolicy: {} },
      where: { id: agent.id },
    });
    assert.equal(
      (
        await requesterApp.inject({
          method: "GET",
          url: `/api/browser-sessions/${preLoginEphemeral.id}`,
        })
      ).statusCode,
      404,
      "revoking browser_open removes live-session exposure",
    );
    assert.equal(
      (
        await requesterApp.inject({
          method: "POST",
          url: `/api/browser-sessions/${preLoginEphemeral.id}/control`,
        })
      ).statusCode,
      404,
      "revoking browser_open prevents control acquisition",
    );
    assert.equal(
      (
        await requesterApp.inject({
          method: "DELETE",
          url: `/api/browser-sessions/${preLoginEphemeral.id}/control`,
        })
      ).statusCode,
      204,
      "revocation still permits the current holder to hand control back",
    );
    await requesterApp.close();
    await strangerApp.close();
    await assert.rejects(
      respondToAgentCard(deps as never, {
        actionKey: "done",
        actorContext,
        card: found!,
      }),
      (error: unknown) =>
        error instanceof AgentCardResponseError &&
        error.code === "CARD_NOT_OPEN",
    );
  },
);
