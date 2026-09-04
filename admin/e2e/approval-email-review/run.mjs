#!/usr/bin/env node
// Browser proof for the private email-approval doorway: a durable alert opens
// /approvals, the exact approver alone sees the frozen proposal, and a second
// confirmation is required before it is resolved.
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

import { PrismaClient } from '@prisma/client'

import {
  ADMIN_URL,
  API_URL,
  REPO_ROOT,
  databaseUrl,
  keepServers,
} from '../navigation/lib/config.mjs'
import { launchBrowser, openViewportContext } from '../navigation/lib/browser.mjs'
import { seedTeam } from '../navigation/lib/seed.mjs'
import { startAdmin, startApi, stopProcess } from '../navigation/lib/servers.mjs'

const SCREENSHOT_ROOT = resolve(REPO_ROOT, 'e2e', 'screenshots', 'approval-email-review')

const fail = (message) => { throw new Error(`approval email review e2e: ${message}`) }

const isolatedDatabaseName = () => `e2e_email_approval_${randomUUID().replaceAll('-', '')}`

const withDatabase = (url, database) => {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  parsed.searchParams.set('schema', 'public')
  return parsed.toString()
}

const runMigration = async (database) => new Promise((done, failMigration) => {
  const command = resolve(REPO_ROOT, 'node_modules', '.bin', 'prisma')
  const child = spawn(command, ['migrate', 'deploy', '--schema', 'api/prisma/schema.prisma'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: database },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = []
  child.stdout.on('data', (chunk) => { output.push(String(chunk)) })
  child.stderr.on('data', (chunk) => { output.push(String(chunk)) })
  child.on('error', failMigration)
  child.on('exit', (code) => {
    if (code === 0) done()
    else failMigration(new Error(`migration exited ${code}: ${output.join('').slice(-2000)}`))
  })
})

const createIsolatedDatabase = async (baseDatabase) => {
  const databaseName = isolatedDatabaseName()
  const prisma = new PrismaClient({ datasources: { db: { url: baseDatabase } } })
  try {
    // A schema cannot see the pgvector type already installed in `public`;
    // an otherwise empty database can. This is an exclusive test database, so
    // dev-login's oldest-user rule and worker queues cannot race shared data.
    await prisma.$executeRawUnsafe(`CREATE DATABASE "${databaseName}" TEMPLATE template0`)
    const database = withDatabase(baseDatabase, databaseName)
    await runMigration(database)
    return { database, databaseName, prisma }
  } catch (error) {
    await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => {})
    await prisma.$disconnect()
    throw error
  }
}

const dropIsolatedDatabase = async (fixture) => {
  if (!fixture) return
  await fixture.prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${fixture.databaseName}"`)
  await fixture.prisma.$disconnect()
}

const apiGet = async (path, token) => {
  const response = await fetch(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) fail(`GET ${path} returned ${response.status}`)
  return (await response.json()).data
}

const seedApproval = async (seed) => {
  const me = await apiGet('/api/auth/me', seed.token)
  const prisma = new PrismaClient()
  const marker = randomUUID()
  try {
    const agent = await prisma.agent.findFirstOrThrow({
      where: { organizationId: me.context.organizationId },
    })
    const mailbox = await prisma.mailboxConnection.create({
      data: {
        address: `support-${marker.slice(0, 8)}@example.test`,
        createdByUserId: me.user.id,
        imapHost: 'imap.example.test',
        imapPort: 993,
        imapSecurity: 'tls',
        label: 'Customer support',
        organizationId: me.context.organizationId,
        ownerUserId: me.user.id,
        smtpHost: 'smtp.example.test',
        smtpPort: 465,
        smtpSecurity: 'tls',
        username: `support-${marker.slice(0, 8)}@example.test`,
      },
    })
    const run = await prisma.run.create({
      data: {
        agentId: agent.id,
        status: 'waiting_approval',
        threadId: seed.channels[0].defaultThreadId,
      },
    })
    const approval = await prisma.approvalRequest.create({
      data: {
        action: 'tool.invoke',
        agentId: agent.id,
        argsHash: marker,
        channelId: seed.channels[0].id,
        context: {
          audience: 'The recipients will receive it',
          headline: 'Send an email from a connected mailbox',
          toolName: 'mailbox_send',
        },
        continuationToken: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
        organizationId: me.context.organizationId,
        projectId: me.context.projectId,
        reason: 'The agent needs your approval before sending email.',
        requesterId: agent.id,
        requiredApproverUserId: me.user.id,
        runId: run.id,
        resumeState: {
          args: {
            bcc: [],
            cc: ['finance@example.test'],
            connectionId: mailbox.id,
            subject: 'Private contract update',
            text: 'The customer-specific terms are ready to send.',
            to: ['customer@example.test'],
          },
        },
        teamId: me.context.teamId,
        toolCallId: randomUUID(),
        toolName: 'mailbox_send',
      },
    })
    await prisma.userAlert.create({
      data: {
        actorAgentId: agent.id,
        approvalRequestId: approval.id,
        channelId: seed.channels[0].id,
        eventKey: `approval-review-e2e:${marker}`,
        kind: 'approval_requested',
        organizationId: me.context.organizationId,
        userId: me.user.id,
      },
    })
    const notice = await prisma.message.create({
      data: {
        agentId: agent.id,
        content: 'I have prepared an email and need your approval before I send it.',
        metadata: {
          approvalGate: {
            approvalId: approval.id,
            status: 'pending',
            toolName: 'mailbox_send',
          },
        },
        role: 'assistant',
        threadId: seed.channels[0].defaultThreadId,
      },
    })
    return {
      approvalId: approval.id,
      mailboxId: mailbox.id,
      noticeId: notice.id,
      prisma,
      senderAddress: mailbox.address,
    }
  } catch (error) {
    await prisma.$disconnect()
    throw error
  }
}

const verify = async (browser, seed, fixture) => {
  const shell = await openViewportContext(browser, { name: 'desktop', token: seed.token })
  const target = await shell.newPage()
  try {
    const { page } = target
    await page.goto(`${ADMIN_URL}/channels/${seed.channels[0].id}`, { waitUntil: 'domcontentloaded' })
    const gate = page.getByTestId('run-approval-gate')
    await gate.waitFor()
    await gate.getByTestId('run-approval-gate-review-email').click()
    if (await gate.getByTestId('run-approval-gate-open-confirm').count() !== 0) {
      fail('chat presented a generic confirmation for an email send')
    }
    if (await gate.getByTestId('run-approval-gate-always').count() !== 0) {
      fail('chat presented standing consent for an email send')
    }
    const review = page.getByRole('dialog', { name: 'Review email' })
    const sender = review
      .getByText('From', { exact: true })
      .locator('xpath=following-sibling::dd[1]')
    await sender.waitFor()
    const senderText = await sender.textContent()
    if (!senderText?.includes('Customer support') || !senderText.includes(fixture.senderAddress)) {
      fail(`sender identity is incomplete: ${senderText ?? 'missing'}`)
    }
    await review.getByText('customer@example.test', { exact: true }).waitFor()
    await review.getByText('Private contract update', { exact: true }).waitFor()
    await review.getByText('The customer-specific terms are ready to send.', { exact: true }).waitFor()
    await review.getByTestId('approval-decision-open-confirm').click()

    const confirm = page.getByRole('dialog', { name: 'Approve this action?' })
    await confirm.getByText('This sends the exact email you just reviewed.', { exact: true }).waitFor()
    await mkdir(SCREENSHOT_ROOT, { recursive: true })
    await page.screenshot({
      fullPage: true,
      path: resolve(SCREENSHOT_ROOT, 'approver-confirmation.png'),
    })
    await confirm.getByTestId('confirm-dialog-confirm').click()
    await review.waitFor({ state: 'hidden' })
    await gate.getByText('approved', { exact: true }).waitFor()
    if (target.errors.length > 0) fail(`page errors: ${target.errors.join(' | ')}`)
  } finally {
    await target.close()
    await shell.close()
  }
}

const main = async () => {
  if (!databaseUrl()) {
    console.log('approval email review e2e: SKIPPED — DATABASE_URL is not configured')
    return
  }

  let api = null
  let admin = null
  let browser = null
  let fixture = null
  let isolated = null
  const baseDatabase = databaseUrl()
  try {
    isolated = await createIsolatedDatabase(baseDatabase)
    process.env.DATABASE_URL = isolated.database
    api = await startApi({ requireOwned: true })
    admin = await startAdmin({ requireOwned: true })
    const seed = await seedTeam(api)
    fixture = await seedApproval(seed)
    browser = await launchBrowser()
    await verify(browser, seed, fixture)
    console.log(`approval email review e2e: PASS — screenshot in ${SCREENSHOT_ROOT}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (fixture) {
      await fixture.prisma.message.delete({ where: { id: fixture.noticeId } })
      await fixture.prisma.userAlert.deleteMany({ where: { approvalRequestId: fixture.approvalId } })
      await fixture.prisma.approvalRequest.delete({ where: { id: fixture.approvalId } })
      await fixture.prisma.mailboxConnection.delete({ where: { id: fixture.mailboxId } })
      await fixture.prisma.$disconnect()
    }
    if (!keepServers()) {
      await stopProcess(admin)
      await stopProcess(api)
    }
    await dropIsolatedDatabase(isolated)
    process.env.DATABASE_URL = baseDatabase
  }
}

await main()
