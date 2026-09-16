// The organisation the website's screenshots are taken of.
//
// Every scene here exists because a row on the homepage claims something, and
// a claim without a screen behind it is the one thing the marketing handover
// forbids (docs/plans/2026-09-14-marketing-site-handover.md → "No invented
// proof"). So: three named agents with owners and inboxes, a handoff that
// runs across two of them in one thread, a person and an agent in the same
// conversation, and the approval, ledger and audit rows that back "asks before
// it matters" and "shows its work and its cost".
//
// The people and the company are invented and say so in their domain
// (`northwind.example`); no customer, no colleague and no real mailbox appears
// in a published asset. What is NOT invented is the product: every row is
// written into the schema the running admin reads, so a screenshot cannot
// drift from what Nessie does without the capture breaking first.
import { PrismaClient } from '@prisma/client'

/** The bootstrap tenant the API provisions on a fresh database. */
export const TENANT = {
  channelId: '00000000-0000-4000-8000-000000000004',
  organizationId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  teamId: '00000000-0000-4000-8000-000000000003',
}

/** Anything invented carries this domain, so a stray real address is visible. */
const DOMAIN = 'northwind.example'

/** Fixed ids keep the manifest's routes stable between runs. */
export const IDS = {
  ada: 'a0000000-0000-4000-8000-000000000003',
  handoffThread: 'c0000000-0000-4000-8000-000000000002',
  leo: 'a0000000-0000-4000-8000-000000000002',
  mia: 'a0000000-0000-4000-8000-000000000001',
  knowledgePage: 'f0000000-0000-4000-8000-000000000001',
  mailChannel: 'b0000000-0000-4000-8000-000000000003',
  mailConversation: 'd0000000-0000-4000-8000-000000000001',
  mailThread: 'c0000000-0000-4000-8000-000000000003',
  mailbox: 'e0000000-0000-4000-8000-000000000001',
  opsChannel: 'b0000000-0000-4000-8000-000000000002',
  salesChannel: 'b0000000-0000-4000-8000-000000000001',
  salesThread: 'c0000000-0000-4000-8000-000000000001',
}

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000)

const agentSeed = [
  {
    avatarBackgroundColor: '#2f9e6b',
    id: IDS.mia,
    mailbox: 'mia',
    name: 'Mia Nováková',
    role: 'Customer Support',
    systemPrompt: 'Answer customer mail within the hour. Escalate anything about refunds to a person.',
  },
  {
    avatarBackgroundColor: '#0266fa',
    id: IDS.leo,
    mailbox: 'leo',
    name: 'Leo Hartmann',
    role: 'Research Analyst',
    systemPrompt: 'Check every figure against the source before it leaves the thread.',
  },
  {
    avatarBackgroundColor: '#d9a02b',
    id: IDS.ada,
    mailbox: 'ada',
    name: 'Ada Lindqvist',
    role: 'Finance Assistant',
    systemPrompt: 'Prepare the monthly report and chase the paperwork nobody enjoys chasing.',
  },
]

const peopleSeed = [
  { displayName: 'Klára Benešová', email: `klara@${DOMAIN}`, key: 'klara' },
  { displayName: 'Tomáš Dvořák', email: `tomas@${DOMAIN}`, key: 'tomas' },
]

/** Upsert by a natural key so a re-run reuses rather than duplicates. */
const ensureUser = async (prisma, { displayName, email }) => {
  const existing = await prisma.user.findFirst({ where: { email } })
  if (existing) return existing
  return prisma.user.create({ data: { displayName, email } })
}

const ensureMember = async (prisma, userId, role = 'member') =>
  prisma.organizationMember.upsert({
    create: { organizationId: TENANT.organizationId, role, userId },
    update: { role },
    where: { organizationId_userId: { organizationId: TENANT.organizationId, userId } },
  })

const ensureChannel = async (prisma, { id, label, slug, topic }) =>
  prisma.channel.upsert({
    create: {
      id,
      label,
      organizationId: TENANT.organizationId,
      projectId: TENANT.projectId,
      // A standard channel without one trips the `channels_standard_slug_required`
      // check constraint at runtime, not at typecheck.
      slug,
      teamId: TENANT.teamId,
      topic,
      type: 'standard',
      visibility: 'public',
    },
    update: { label, topic },
    where: { id },
  })

const ensureThread = async (prisma, { channelId, id, startedByUserId, title }) =>
  prisma.thread.upsert({
    create: { agentId: null, channelId, id, startedByUserId, title },
    update: { title },
    where: { id },
  })

/**
 * Posts happen in order and minutes apart, because a feed where every message
 * shares a timestamp reads as fake at a glance.
 */
const postAll = async (prisma, threadId, posts) => {
  await prisma.message.deleteMany({ where: { threadId } })
  const written = []
  for (const [index, post] of posts.entries()) {
    written.push(await prisma.message.create({
      data: {
        agentId: post.agentId ?? null,
        content: post.content,
        createdAt: minutesAgo(posts.length * 6 - index * 6),
        role: post.agentId ? 'assistant' : 'user',
        threadId,
        userId: post.userId ?? null,
      },
    }))
  }
  return written
}

/**
 * An agent's own inbox: a real customer mail arriving at a real address, and
 * the agent's reply held back for a person. Both halves are the point — the
 * address is what "its own email address" means, and the held reply is what
 * "asks before it matters" means.
 */
const seedMailbox = async (prisma, ownerUserId) => {
  const mailboxChannel = await ensureChannel(prisma, {
    id: IDS.mailChannel,
    label: 'Mia — mail',
    slug: 'mia-mail',
    topic: null,
  })
  const mailbox = await prisma.agentMailbox.upsert({
    create: {
      address: `mia@${DOMAIN}`,
      agentId: IDS.mia,
      channelId: mailboxChannel.id,
      createdByUserId: ownerUserId,
      displayName: 'Mia Nováková',
      id: IDS.mailbox,
      organizationId: TENANT.organizationId,
      // The default: nothing leaves the building without a person saying so.
      sendPolicy: 'approval',
      status: 'active',
    },
    update: { address: `mia@${DOMAIN}`, displayName: 'Mia Nováková' },
    where: { id: IDS.mailbox },
  })
  const thread = await ensureThread(prisma, {
    channelId: mailboxChannel.id,
    id: IDS.mailThread,
    startedByUserId: ownerUserId,
    title: 'Renewal quote for Waverley',
  })
  const conversation = await prisma.emailConversation.upsert({
    create: {
      id: IDS.mailConversation,
      lastMessageAt: minutesAgo(35),
      mailboxId: mailbox.id,
      messageCount: 2,
      organizationId: TENANT.organizationId,
      participants: [
        { address: `hana.prochazkova@waverley.${DOMAIN.split('.').pop()}`, name: 'Hana Procházková' },
        { address: `mia@${DOMAIN}`, name: 'Mia Nováková' },
      ],
      subject: 'Renewal quote for Waverley',
      threadId: thread.id,
    },
    update: { lastMessageAt: minutesAgo(35), messageCount: 2 },
    where: { id: IDS.mailConversation },
  })
  await prisma.emailMessage.deleteMany({ where: { conversationId: conversation.id } })
  await prisma.emailMessage.create({
    data: {
      conversationId: conversation.id,
      createdAt: minutesAgo(52),
      direction: 'inbound',
      occurredAt: minutesAgo(52),
      fromAddress: `hana.prochazkova@waverley.example`,
      fromName: 'Hana Procházková',
      mailboxId: mailbox.id,
      organizationId: TENANT.organizationId,
      rfcMessageId: '<renewal-1@waverley.example>',
      snippet: 'Our team plan renews on 1 October. Could you send a quote for 40 seats before Friday?',
      subject: 'Renewal quote for Waverley',
      textBody: 'Hello,\n\nOur team plan renews on 1 October. Could you send a quote for 40 seats before Friday?\n\nThanks,\nHana',
      toAddresses: [`mia@${DOMAIN}`],
    },
  })
  await prisma.emailMessage.create({
    data: {
      conversationId: conversation.id,
      createdAt: minutesAgo(35),
      direction: 'outbound',
      occurredAt: minutesAgo(35),
      fromAddress: `mia@${DOMAIN}`,
      fromName: 'Mia Nováková',
      inReplyTo: '<renewal-1@waverley.example>',
      mailboxId: mailbox.id,
      organizationId: TENANT.organizationId,
      rfcMessageId: '<renewal-2@nessie.example>',
      snippet: 'Here is the quote for 40 seats at the renewal rate, valid until 1 October.',
      subject: 'Re: Renewal quote for Waverley',
      textBody: 'Hello Hana,\n\nHere is the quote for 40 seats at the renewal rate, valid until 1 October.\n\nMia',
      toAddresses: [`hana.prochazkova@waverley.example`],
    },
  })
  return { channelId: mailboxChannel.id, mailboxId: mailbox.id }
}

/** The gate itself: work that stopped and is waiting for a person. */
const seedApprovals = async (prisma, ownerUserId, channels) => {
  await prisma.approvalRequest.deleteMany({ where: { organizationId: TENANT.organizationId } })
  const pending = [
    {
      action: 'email.send',
      agentId: IDS.mia,
      channelId: channels.sales,
      context: { recipient: 'hana.prochazkova@waverley.example', subject: 'Re: Renewal quote for Waverley' },
      reason: 'Sending a quote to a customer — a person reads it before it leaves.',
    },
    {
      action: 'expense.approve',
      agentId: IDS.ada,
      channelId: channels.ops,
      context: { amount: '€4,120', period: 'September' },
      reason: 'Reclassifying two invoices across the month end changes the reported revenue line.',
    },
  ]
  for (const [index, request] of pending.entries()) {
    await prisma.approvalRequest.create({
      data: {
        ...request,
        continuationToken: `marketing-shots-${index}`,
        createdAt: minutesAgo(30 - index * 9),
        // A gate that never expires is not a gate; the product requires a deadline.
        expiresAt: minutesAgo(-60 * 24),
        organizationId: TENANT.organizationId,
        projectId: TENANT.projectId,
        requesterId: request.agentId,
        status: 'pending',
        teamId: TENANT.teamId,
      },
    })
  }
}

/** "Every action audited": the trail an agent leaves behind it. */
const seedAudit = async (prisma, ownerUserId, channels) => {
  await prisma.auditLog.deleteMany({ where: { organizationId: TENANT.organizationId, requestId: { startsWith: 'marketing-shots' } } })
  const events = [
    { action: 'email.send', actorId: IDS.mia, actorType: 'agent', outcome: 'success', reason: 'Approved by Klára Benešová', resourceType: 'email_message' },
    { action: 'approval.request', actorId: IDS.ada, actorType: 'agent', outcome: 'success', reason: 'Revenue line changed by more than €1,000', resourceType: 'approval_request' },
    { action: 'document.read', actorId: IDS.leo, actorType: 'agent', outcome: 'success', reason: 'September invoice export', resourceType: 'document' },
    { action: 'mailbox.read', actorId: IDS.mia, actorType: 'agent', outcome: 'success', reason: null, resourceType: 'agent_mailbox' },
    { action: 'channel.join', actorId: IDS.leo, actorType: 'agent', outcome: 'denied', reason: 'Not a member of this project', resourceType: 'channel' },
    { action: 'agent.create', actorId: ownerUserId, actorType: 'user', outcome: 'success', reason: null, resourceType: 'agent' },
  ]
  for (const [index, event] of events.entries()) {
    await prisma.auditLog.create({
      data: {
        ...event,
        channelId: index % 2 === 0 ? channels.sales : channels.ops,
        createdAt: minutesAgo(12 + index * 17),
        organizationId: TENANT.organizationId,
        projectId: TENANT.projectId,
        requestId: `marketing-shots-${index}`,
        resourceId: null,
        teamId: TENANT.teamId,
      },
    })
  }
}

/** "Always on": the schedules that keep work moving with nobody on call. */
const seedTriggers = async (prisma, channels) => {
  await prisma.agentTrigger.deleteMany({ where: { agentId: { in: [IDS.mia, IDS.leo, IDS.ada] } } })
  const triggers = [
    { agentId: IDS.ada, config: { cron: '0 7 1 * *', timezone: 'Europe/Prague' }, description: 'Builds the close on the first of the month, before anyone is in.', name: 'Month-end close', nextRunAt: minutesAgo(-2_880), targetChannelId: channels.ops, type: 'scheduled' },
    { agentId: IDS.mia, config: { cron: '*/15 * * * *', timezone: 'Europe/Prague' }, description: 'Checks the inbox every fifteen minutes, including at the weekend.', name: 'Customer mail sweep', nextRunAt: minutesAgo(-11), targetChannelId: channels.sales, type: 'scheduled' },
    { agentId: IDS.leo, config: { event: 'invoice.created' }, description: 'Re-checks the revenue line whenever an invoice is raised.', name: 'Invoice raised', nextRunAt: null, targetChannelId: channels.ops, type: 'event' },
  ]
  for (const trigger of triggers) {
    await prisma.agentTrigger.create({
      data: { ...trigger, enabled: true, lastFiredAt: minutesAgo(48), status: 'active' },
    })
  }
}

/**
 * A page an agent wrote: the research and the first draft already done, which
 * is what "room for creative work" claims a person gets back.
 *
 * Written into the knowledge base rather than posted in a thread because the
 * claim is about work that is *waiting* for you, not work that scrolled past.
 */
const seedKnowledge = async (prisma) => {
  // The shared space, never the oldest one: the oldest is the owner's private
  // "My Docs", and a page filed there is invisible to everyone else — which is
  // the opposite of the claim this picture is for.
  const space = await prisma.knowledgeSpace.findFirst({
    orderBy: { createdAt: 'asc' },
    where: {
      deletedAt: null,
      organizationId: TENANT.organizationId,
      privateToAgentId: null,
      visibility: 'project',
    },
  })
  if (!space) return null
  // Plain prose, not Markdown: a knowledge *page*'s body is stored and shown
  // as written (the Markdown renderer belongs to uploaded `.md` files — see
  // `admin/e2e/knowledge-markdown`), so `#` and `-` would appear as typed.
  const body = [
    'Prepared by Leo Hartmann the night before the call. Every figure checked against the invoice export.',
    '',
    'Where they are today',
    '',
    'Forty seats on the team plan, renewing on 1 October. Usage is up 31% against the same quarter last year. Two support tickets this quarter, both answered inside the hour.',
    '',
    'What to raise',
    '',
    'They have outgrown the seat count twice in eighteen months, so offer the next tier before they have to ask for it. Their finance team asked for consolidated invoicing back in March; it shipped in July, and nobody has told them. Nothing is outstanding on their account.',
    '',
    'What I could not answer',
    '',
    'Whether their new Brno office comes under the same contract. Worth asking on the call.',
  ].join('\n')
  const page = await prisma.knowledgePage.upsert({
    create: {
      createdBy: IDS.leo,
      id: IDS.knowledgePage,
      kind: 'document',
      organizationId: TENANT.organizationId,
      projectId: TENANT.projectId,
      spaceId: space.id,
      status: 'published',
      summary: 'Everything worth knowing before the renewal call, gathered overnight.',
      teamId: TENANT.teamId,
      title: 'Waverley — renewal brief',
    },
    update: { status: 'published', title: 'Waverley — renewal brief' },
    where: { id: IDS.knowledgePage },
  })
  const version = await prisma.knowledgePageVersion.create({
    data: {
      // The point of the shot: an agent wrote this, and the row says so.
      authorId: IDS.leo,
      authorType: 'agent',
      body,
      pageId: page.id,
      versionNumber: page.revision + 1,
    },
  })
  await prisma.knowledgePage.update({
    data: { publishedVersionId: version.id, revision: version.versionNumber },
    where: { id: page.id },
  })
  return { pageId: page.id, spaceId: space.id }
}

export const seedMarketingOrganisation = async (databaseUrl, ownerUserId) => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  try {
    await prisma.organization.update({
      data: { name: 'Northwind' },
      where: { id: TENANT.organizationId },
    })

    const people = {}
    for (const person of peopleSeed) {
      const user = await ensureUser(prisma, person)
      await ensureMember(prisma, user.id)
      people[person.key] = user
    }
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerUserId } })

    // Agents are written straight to the table rather than through
    // `POST /api/agents`: that route generates an avatar, which needs a
    // Ledger-routed model key a local capture run has no business holding.
    for (const agent of agentSeed) {
      const data = {
        agentKind: 'shared',
        avatarBackgroundColor: agent.avatarBackgroundColor,
        name: agent.name,
        organizationId: TENANT.organizationId,
        ownerUserId,
        projectId: TENANT.projectId,
        role: agent.role,
        status: 'idle',
        systemPrompt: agent.systemPrompt,
        teamId: TENANT.teamId,
        visibility: 'team',
      }
      await prisma.agent.upsert({ create: { id: agent.id, ...data }, update: data, where: { id: agent.id } })
    }
    // Ada belongs to Klára, so "each of your people can direct several agents"
    // has more than one owner on screen.
    await prisma.agent.update({ data: { ownerUserId: people.klara.id }, where: { id: IDS.ada } })

    const sales = await ensureChannel(prisma, {
      id: IDS.salesChannel,
      label: 'Customers',
      slug: 'customers',
      topic: 'Everything that reaches a customer — people and agents together.',
    })
    const ops = await ensureChannel(prisma, {
      id: IDS.opsChannel,
      label: 'Month end',
      slug: 'month-end',
      topic: 'The close, handled by the agents who do it every month.',
    })

    for (const channel of [sales, ops]) {
      for (const userId of [ownerUserId, people.klara.id, people.tomas.id]) {
        await prisma.channelMember.upsert({
          create: { channelId: channel.id, role: userId === ownerUserId ? 'owner' : 'member', userId },
          update: {},
          where: { channelId_userId: { channelId: channel.id, userId } },
        })
      }
    }
    // Bindings are what put an agent in a room; the strip in the header reads
    // them, and two in one room is what the "team of agents" row needs.
    const bindings = [
      { agentId: IDS.mia, channelId: sales.id },
      { agentId: IDS.leo, channelId: sales.id },
      { agentId: IDS.leo, channelId: ops.id },
      { agentId: IDS.ada, channelId: ops.id },
    ]
    await prisma.agentBinding.deleteMany({ where: { channelId: { in: [sales.id, ops.id] } } })
    for (const binding of bindings) await prisma.agentBinding.create({ data: binding })

    const salesThread = await ensureThread(prisma, {
      channelId: sales.id,
      id: IDS.salesThread,
      startedByUserId: ownerUserId,
      title: null,
    })
    const handoffThread = await ensureThread(prisma, {
      channelId: ops.id,
      id: IDS.handoffThread,
      startedByUserId: ownerUserId,
      title: null,
    })

    // People and agents in one conversation: a person asks, an agent answers,
    // a second person picks the thread back up.
    await postAll(prisma, salesThread.id, [
      { content: 'Waverley have asked for a renewal quote before Friday. @Mia can you pull what they are on today?', userId: ownerUserId },
      { agentId: IDS.mia, content: 'They are on the 40-seat team plan, renewing 1 October. Two support tickets open, both answered. I have the last two invoices if you want the numbers in the quote.' },
      { content: 'Numbers please — and the renewal date on the covering note.', userId: people.klara.id },
      { agentId: IDS.mia, content: 'Drafted. It quotes 40 seats at the renewal rate and puts the date at the top. It is waiting for you to send — I do not email a customer without a person reading it first.' },
      { content: 'Reading it now. Thanks Mia.', userId: people.klara.id },
    ])

    // The handoff: Ada starts it, asks Leo, Leo answers, Ada finishes — all in
    // one thread, which is the whole of "handoffs without meetings".
    await postAll(prisma, handoffThread.id, [
      { content: 'Month end. @Ada can you start the close?', userId: ownerUserId },
      { agentId: IDS.ada, content: 'Started. Ledger is reconciled to the 30th and the expense claims are in. One thing I cannot settle on my own: the September revenue line does not match the invoices by €4,120.' },
      { agentId: IDS.ada, content: 'Handing the revenue check to @Leo — it is his source data.' },
      { agentId: IDS.leo, content: 'Found it. Two invoices were raised on 1 October and booked to September. Moving them puts the line at €312,480, which matches the ledger exactly.' },
      { agentId: IDS.ada, content: 'Taking it back. Report rebuilt on €312,480 and the variance note is gone. Ready for a person to sign off.' },
    ])

    const channels = { ops: ops.id, sales: sales.id }
    const mailbox = await seedMailbox(prisma, ownerUserId)
    await seedApprovals(prisma, ownerUserId, channels)
    await seedAudit(prisma, ownerUserId, channels)
    await seedTriggers(prisma, channels)
    const knowledge = await seedKnowledge(prisma)

    return {
      knowledge,
      mailbox,
      agents: agentSeed.map(({ id, name, role }) => ({ id, name, role })),
      channels: { ops: ops.id, sales: sales.id },
      owner: { id: owner.id, name: owner.displayName },
      people,
      threads: { handoff: handoffThread.id, sales: salesThread.id },
    }
  } finally {
    await prisma.$disconnect()
  }
}
