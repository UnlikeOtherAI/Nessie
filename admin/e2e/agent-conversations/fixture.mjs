// One organisation, two people, one ordinary agent and the Personal Assistant.
//
// The shape the cases need: A can see everything, B can see only the public
// room, and agent X is bound to both — so "the list shows only what the viewer
// is privy to" has something to withhold. Every row is written through the
// same functions the product writes them with (`seedScope`,
// `ensurePersonalAssistantBootstrap`); nothing here re-implements a rule the
// suite then proves.
import { MemberRole } from '@prisma/client'
import { randomUUID } from 'node:crypto'

/** Sent in the first conversation; must never appear in the second. */
export const ALPHA_QUESTION = 'Alpha question one'
/** Sent in the second conversation; must never appear in the first. */
export const BETA_QUESTION = 'Beta question two'

export const seedFixture = async (pipeline, seedScope, ensurePersonalAssistantBootstrap) => {
  const prisma = pipeline.prisma
  const scope = await seedScope(prisma, 'agent-conversations-browser')
  const suffix = scope.organizationId.slice(0, 8)
  const owner = { id: scope.userId, role: MemberRole.owner, sessionId: randomUUID() }
  const outsider = await prisma.user.create({
    data: {
      displayName: 'Bára Outsider',
      email: `agent-conversations-outsider-${Date.now()}@example.test`,
    },
  })
  const outsiderSessionId = randomUUID()

  const agentName = `Pricing Analyst ${suffix}`
  // A's own room with the agent — a two-party `dm` whose bindings are exactly
  // this agent, which is the first room `startAgentConversation` resolves to.
  //
  // The browser cases live here rather than in the standard room below because
  // the standard room has no doorway at all: `ChannelsPage.tsx:146` makes
  // `isConversationSurface` true only for a DM or the assistant, and
  // `resolveConversationAgent` (`channel-tabs.ts:67`) returns null without it,
  // so the rail, the header doorway and the "New conversation" button are all
  // absent from an ordinary channel an agent works in. Both files predate this
  // branch, and `privateRoom` below keeps the gap on screen rather than hiding
  // it (`run.mjs` → the `standard-room` case).
  const dmRoom = await prisma.channel.create({
    data: {
      dmKey: `agent:${scope.organizationId}:${owner.id}:${scope.agentId}`,
      label: agentName,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      teamId: scope.teamId,
      type: 'dm',
      visibility: 'private',
    },
  })
  // Private and standard: A is a member, B is not, and the agent is bound — so
  // its General row belongs in A's list through the binding arm and in nobody
  // else's.
  const privateRoom = await prisma.channel.create({
    data: {
      label: 'Pricing room',
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      // A standard channel carries a slug (check constraint); a DM does not.
      slug: `pricing-room-${suffix}`,
      teamId: scope.teamId,
      visibility: 'private',
    },
  })
  // Public: both people are members. Only the withheld-card proof uses it — one
  // doorway, two readers, two different renderings.
  const publicRoom = await prisma.channel.create({
    data: {
      label: 'Team desk',
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      slug: `team-desk-${suffix}`,
      teamId: scope.teamId,
      visibility: 'public',
    },
  })
  const [dmThread, privateThread, publicThread] = await Promise.all([
    prisma.thread.create({ data: { channelId: dmRoom.id, title: agentName } }),
    prisma.thread.create({ data: { channelId: privateRoom.id, title: 'Pricing room' } }),
    prisma.thread.create({ data: { channelId: publicRoom.id, title: 'Team desk' } }),
  ])

  await prisma.$transaction([
    prisma.authSession.createMany({
      data: [
        { id: owner.sessionId, userId: owner.id },
        { id: outsiderSessionId, userId: outsider.id },
      ],
    }),
    prisma.refreshToken.createMany({
      data: [
        { sessionId: owner.sessionId, userId: owner.id },
        { sessionId: outsiderSessionId, userId: outsider.id },
      ].map((entry) => ({
        expiresAt: new Date(Date.now() + 86_400_000),
        familyId: entry.sessionId,
        providerId: 'local',
        providerType: 'local-bootstrap',
        sessionId: entry.sessionId,
        tokenHash: `agent-conversations-session-${entry.userId}`,
        userId: entry.userId,
      })),
    }),
    prisma.organizationMember.createMany({
      data: [
        { organizationId: scope.organizationId, role: MemberRole.owner, userId: owner.id },
        { organizationId: scope.organizationId, role: MemberRole.member, userId: outsider.id },
      ],
    }),
    prisma.projectMember.createMany({
      data: [
        { projectId: scope.projectId, role: MemberRole.member, userId: owner.id },
        { projectId: scope.projectId, role: MemberRole.member, userId: outsider.id },
      ],
    }),
    prisma.teamMember.createMany({
      data: [
        { teamId: scope.teamId, role: MemberRole.member, userId: owner.id },
        { teamId: scope.teamId, role: MemberRole.member, userId: outsider.id },
      ],
    }),
    prisma.channelMember.createMany({
      data: [
        { channelId: dmRoom.id, role: MemberRole.member, userId: owner.id },
        { channelId: privateRoom.id, role: MemberRole.member, userId: owner.id },
        { channelId: publicRoom.id, role: MemberRole.member, userId: owner.id },
        { channelId: publicRoom.id, role: MemberRole.member, userId: outsider.id },
      ],
    }),
    // An ordinary shared agent, inserted rather than created through the agent
    // route: the route generates an avatar, which is a model call this suite
    // has no business scripting.
    prisma.agent.update({
      where: { id: scope.agentId },
      data: {
        agentKind: 'shared',
        name: agentName,
        ownerUserId: owner.id,
        projectId: scope.projectId,
        systemManaged: false,
        teamId: scope.teamId,
        visibility: 'team',
      },
    }),
    prisma.agentBinding.createMany({
      data: [
        { agentId: scope.agentId, channelId: dmRoom.id },
        { agentId: scope.agentId, channelId: privateRoom.id },
      ],
    }),
  ])

  // The Personal Assistant, through the very function every sign-in calls. Its
  // DM, its thread and its default tool grants come with it — including
  // `agent_conversation_start`, which the card case needs in the toolset.
  const assistant = await ensurePersonalAssistantBootstrap(prisma, {
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    userId: owner.id,
  })

  return {
    agent: { id: scope.agentId, name: agentName },
    assistant,
    dmRoom,
    dmThread,
    outsider: { id: outsider.id, role: MemberRole.member, sessionId: outsiderSessionId },
    owner,
    privateRoom,
    privateThread,
    publicRoom,
    publicThread,
    scope,
  }
}

/** A session token for one of the fixture's people, exactly as the API mints one. */
export const tokenFor = (issueSessionToken, user, scope) => issueSessionToken({
  org: scope.organizationId,
  proj: scope.projectId,
  providerId: 'local',
  providerType: 'local-bootstrap',
  roles: [user.role],
  sub: user.id,
  team: scope.teamId,
  tv: 0,
}, process.env.NESSIE_AUTH_SECRET, 3_600, user.sessionId).token

/**
 * The doorway message production writes, planted in a room both people can
 * read.
 *
 * The card itself is server-written only, and the two tools that write it put
 * it where the run was — A's private assistant DM, which B can never open. To
 * see the *card's own* per-viewer resolution in a browser, the same pointer has
 * to sit somewhere both readers stand. This is the one row the suite inserts
 * directly rather than through a door (the precedent is
 * `seedDashboardWorkspace`'s presentation pointer); everything the case then
 * asserts — the fetch, the 404, the withheld idiom — is real product code.
 */
export const plantConversationRef = async (prisma, { agentId, channelId, threadId, into }) =>
  prisma.message.create({
    data: {
      content: 'Sharing where this is being worked on.',
      metadata: { conversationRef: { agentId, channelId, schemaVersion: 1, threadId } },
      role: 'assistant',
      threadId: into,
    },
    select: { id: true },
  })

/** The newest run for (agent, thread), however it was admitted. */
export const waitForRun = async (pipeline, { agentId, threadId, timeoutMs = 60_000 }) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await pipeline.prisma.run.findFirst({
      orderBy: { createdAt: 'desc' },
      where: { agentId, threadId },
    })
    if (run) return run
    await new Promise((done) => { setTimeout(done, 100) })
  }
  throw new Error(`No run was admitted for thread ${threadId}`)
}
