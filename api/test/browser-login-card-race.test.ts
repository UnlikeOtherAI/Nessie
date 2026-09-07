import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";
import { createRequestHelpers } from "../src/lib/request-helpers.js";
import {
  AgentCardResponseError,
  respondToAgentCard,
} from "../src/services/agent-card-response.js";
import { findBrowserLoginCardForViewer } from "../src/services/browser-login-card-selection.js";

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip;

const seedBrowserLogin = async (t: test.TestContext, label: string) => {
  const prisma = new PrismaClient();
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: { name: `${label}-${suffix}` },
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
      slug: `${label}-${suffix.slice(0, 8)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      visibility: "public",
    },
  });
  const thread = await prisma.thread.create({
    data: { channelId: channel.id, title: label },
  });
  const agent = await prisma.agent.create({
    data: {
      name: `a-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  });
  const user = await prisma.user.create({
    data: { displayName: "user", email: `${label}-${suffix}@example.test` },
  });
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: "member", userId: user.id },
  });
  const message = await prisma.message.create({
    data: { agentId: agent.id, content: "Sign in", role: "assistant", threadId: thread.id },
  });
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: "waiting_input", threadId: thread.id, triggerMessageId: message.id },
  });
  await prisma.runCheckpoint.create({
    data: {
      agentId: agent.id,
      note: "wait",
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
      projectId: "test",
      scope: "organization",
    },
  });
  const browser = await prisma.agentBrowser.create({
    data: {
      agentId: agent.id,
      browserbaseContextId: `ctx-${suffix}`,
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
      organizationId: organization.id,
      requestedByUserId: user.id,
      status: "active",
      threadId: thread.id,
    },
  });
  const actorContext = {
    actionContext: { requestId: `${label}-${suffix}` },
    actor: { actorId: user.id, actorType: "user", roles: ["member"] },
    tenant: { organizationId: organization.id },
  } as const;
  const card = await prisma.agentCard.create({
    data: {
      agentId: agent.id,
      browserLogin: { agentBrowserId: browser.id, service: "Example" },
      channelId: channel.id,
      messageId: message.id,
      organizationId: organization.id,
      respondentUserIds: [user.id],
      resumeState: { actorContext, interactive: true, messageId: message.id },
      runId: run.id,
      spec: {
        schemaVersion: 1,
        title: "Sign in",
        blocks: [{ type: "text", markdown: "Sign in, then choose Done." }],
        actions: [{ key: "done", label: "Done", style: "primary", submits: true }],
      },
      status: "open",
      threadId: thread.id,
      waitRunId: run.id,
    },
  });
  t.after(async () => {
    await prisma
      .$executeRaw`DELETE FROM queue_jobs WHERE payload->>'threadId' = ${thread.id}`
      .catch(() => undefined);
    await prisma.organization.deleteMany({ where: { id: organization.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
  });
  return {
    actorContext,
    browser,
    card,
    deps: {
      ...createRequestHelpers(prisma),
      authSecret: "test",
      dashboardCredentials: {},
      mcpSecretStore: {},
      messageMemoryCaptureConfig: null,
      prisma,
      realtimeHub: { publishWs: async () => undefined },
    },
    prisma,
    run,
    session,
    thread,
    user,
  };
};

const loadCard = (fixture: Awaited<ReturnType<typeof seedBrowserLogin>>) =>
  findBrowserLoginCardForViewer(fixture.prisma, {
    agentBrowserId: fixture.browser.id,
    organizationId: fixture.actorContext.tenant.organizationId,
    threadId: fixture.thread.id,
    userId: fixture.user.id,
  });

runDatabaseTest("viewer and card Done race claims one browser-login continuation", async (t) => {
  const fixture = await seedBrowserLogin(t, "race");
  const [cardDone, viewerDone] = await Promise.all([loadCard(fixture), loadCard(fixture)]);
  assert.ok(cardDone);
  assert.ok(viewerDone);

  const results = await Promise.allSettled([
    respondToAgentCard(fixture.deps as never, {
      actionKey: "done",
      actorContext: fixture.actorContext,
      card: cardDone,
    }),
    respondToAgentCard(fixture.deps as never, {
      actionKey: "done",
      actorContext: fixture.actorContext,
      card: viewerDone,
      handoverSessionId: fixture.session.id,
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const loser = results.find((result) => result.status === "rejected");
  assert.ok(loser && loser.status === "rejected");
  assert.ok(loser.reason instanceof AgentCardResponseError);
  assert.equal(loser.reason.code, "CARD_NOT_OPEN");
  assert.equal(
    await fixture.prisma.run.count({ where: { continuationOfRunId: fixture.run.id } }),
    1,
  );
  assert.equal(
    await fixture.prisma.agentBrowserLogin.count({
      where: { agentBrowserId: fixture.browser.id, userId: fixture.user.id },
    }),
    1,
  );
  assert.equal(await fixture.prisma.message.count({ where: { threadId: fixture.thread.id } }), 2);
  assert.deepEqual(
    await fixture.prisma.cloudBrowserSession.findUnique({
      select: { controlledByUserId: true },
      where: { id: fixture.session.id },
    }),
    { controlledByUserId: null },
  );
});

runDatabaseTest("card-only Done releases its session and resumes once", async (t) => {
  const fixture = await seedBrowserLogin(t, "card-only");
  const card = await loadCard(fixture);
  assert.ok(card);

  await respondToAgentCard(fixture.deps as never, {
    actionKey: "done",
    actorContext: fixture.actorContext,
    card,
  });
  assert.equal(
    await fixture.prisma.run.count({ where: { continuationOfRunId: fixture.run.id } }),
    1,
  );
  assert.equal(
    await fixture.prisma.agentBrowserLogin.count({
      where: { agentBrowserId: fixture.browser.id, userId: fixture.user.id },
    }),
    1,
  );
  assert.deepEqual(
    await fixture.prisma.cloudBrowserSession.findUnique({
      select: { controlledByUserId: true },
      where: { id: fixture.session.id },
    }),
    { controlledByUserId: null },
  );
});
