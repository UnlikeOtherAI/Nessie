import type { Feedback, PrismaClient } from '@prisma/client'
import type { NessieConfig } from '@nessie/config'
import type { FeedbackRecord } from '@nessie/schemas'

import { canAccessAttachment } from './attachments.js'
import { createGithubIssue } from './github.js'

export type FeedbackOwner = {
  organizationId: string
  userId: string
}

export type CreateFeedbackInput = {
  title: string
  body: string
  attachmentId?: string | null
}

export class FeedbackServiceError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'FeedbackServiceError'
  }
}

const toRecord = (feedback: Feedback, attachmentFilename: string | null): FeedbackRecord => ({
  id: feedback.id,
  title: feedback.title,
  body: feedback.body,
  attachmentId: feedback.attachmentId ?? null,
  attachmentFilename,
  githubIssueNumber: feedback.githubIssueNumber ?? null,
  githubIssueUrl: feedback.githubIssueUrl ?? null,
  status: feedback.status,
  createdAt: feedback.createdAt.toISOString(),
})

// Compose the issue body from the user's text plus a provenance footer. The
// attachment is referenced by filename + id (internal-link only) — Nessie
// admins can open it via the attachments API; it is never exposed publicly.
const buildIssueBody = (params: {
  body: string
  submitter: string
  organizationId: string
  attachmentFilename: string | null
  attachmentId: string | null
}): string => {
  const lines = [params.body.trim(), '', '---', `Submitted via Nessie by ${params.submitter}`, `Organization: ${params.organizationId}`]
  if (params.attachmentFilename && params.attachmentId) {
    lines.push(`Attachment: ${params.attachmentFilename} (Nessie attachment ${params.attachmentId})`)
  }
  return lines.join('\n')
}

export const createFeedback = async (
  prisma: PrismaClient,
  config: NessieConfig,
  owner: FeedbackOwner,
  input: CreateFeedbackInput,
): Promise<FeedbackRecord> => {
  let attachmentFilename: string | null = null
  const attachmentId = input.attachmentId ?? null

  if (attachmentId) {
    const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } })
    // Scope to the submitter's own uploads (uploaderId === null covers system
    // attachments) so a member cannot attach another member's file to feedback.
    const ownedBySubmitter =
      attachment !== null
      && attachment.organizationId === owner.organizationId
      && (attachment.uploaderId === null || attachment.uploaderId === owner.userId)
    const accessible =
      attachment !== null
      && await canAccessAttachment(prisma, attachment, {
        organizationId: owner.organizationId,
        userId: owner.userId,
      })
    if (!ownedBySubmitter || !accessible) {
      throw new FeedbackServiceError(400, 'INVALID_ATTACHMENT', 'Attachment not found for this user')
    }
    attachmentFilename = attachment.filename
  }

  const user = await prisma.user.findUnique({ where: { id: owner.userId } })
  const submitter = user ? `${user.displayName} <${user.email}>` : owner.userId

  // Best-effort GitHub mirroring: feedback is always stored. Without a token we
  // record status "saved"; on a GitHub error we record "failed" but still keep
  // the submission so nothing the user wrote is lost.
  let status = 'saved'
  let githubIssueNumber: number | null = null
  let githubIssueUrl: string | null = null

  if (config.github.token) {
    try {
      const issue = await createGithubIssue({
        token: config.github.token,
        owner: config.github.owner,
        repo: config.github.repo,
        title: input.title,
        body: buildIssueBody({
          body: input.body,
          submitter,
          organizationId: owner.organizationId,
          attachmentFilename,
          attachmentId,
        }),
      })
      status = 'submitted'
      githubIssueNumber = issue.number
      githubIssueUrl = issue.htmlUrl
    } catch (error) {
      // Never lose the submission: record the failure and keep the row.
      console.warn(
        '[feedback] GitHub issue creation failed:',
        error instanceof Error ? error.message : String(error),
      )
      status = 'failed'
    }
  }

  const feedback = await prisma.feedback.create({
    data: {
      organizationId: owner.organizationId,
      userId: owner.userId,
      title: input.title,
      body: input.body,
      attachmentId,
      githubIssueNumber,
      githubIssueUrl,
      status,
    },
  })

  return toRecord(feedback, attachmentFilename)
}

export const listFeedback = async (
  prisma: PrismaClient,
  owner: FeedbackOwner,
): Promise<FeedbackRecord[]> => {
  const items = await prisma.feedback.findMany({
    where: { organizationId: owner.organizationId, userId: owner.userId },
    orderBy: { createdAt: 'desc' },
    include: { attachment: { select: { filename: true } } },
  })

  return items.map((item) => toRecord(item, item.attachment?.filename ?? null))
}
