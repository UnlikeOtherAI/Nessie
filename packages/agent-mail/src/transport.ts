import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  SendEmailCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2'

import type { AgentMailConfig } from './readiness.js'

/**
 * The one AWS surface for hosted agent mail: SESv2 for identities and sending,
 * S3 for raw inbound MIME. Deliberately a single wrapper rather than two client
 * stacks scattered across the worker and the API.
 *
 * The inbound bucket is **transport staging only** — a named, narrow exception
 * to the one-FileService blob chokepoint. Every durable byte (parsed
 * attachments, anything a person can reach) still goes through FileService.
 */

export type AgentMailTransport = {
  sendRaw(input: {
    rawMessage: string
    fromAddress: string
    destinations: string[]
  }): Promise<{ sesMessageId: string }>
  headInboundObject(key: string): Promise<{ contentLength: number } | null>
  getInboundObject(key: string): Promise<Buffer>
  deleteInboundObject(key: string): Promise<void>
  createDomainIdentity(domain: string): Promise<{ dkimTokens: string[]; identityArn?: string }>
  getDomainIdentity(domain: string): Promise<{
    verified: boolean
    dkimTokens: string[]
    dkimStatus?: string
  } | null>
}

export class InboundObjectTooLargeError extends Error {
  constructor(
    readonly key: string,
    readonly sizeBytes: number,
    readonly limitBytes: number,
  ) {
    super(`Inbound message ${key} is ${sizeBytes} bytes, over the ${limitBytes} byte limit.`)
    this.name = 'InboundObjectTooLargeError'
  }
}

const credentials = (config: AgentMailConfig) =>
  config.accessKeyId && config.secretAccessKey
    ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
    // No static credentials ⇒ the SDK default chain, which is how an instance
    // profile / IRSA role is used. Never invent an anonymous client.
    : undefined

const streamToBuffer = async (body: unknown): Promise<Buffer> => {
  const stream = body as AsyncIterable<Uint8Array> | undefined
  if (!stream || typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') {
    throw new Error('S3 object body was not readable.')
  }
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export const createAgentMailTransport = (config: AgentMailConfig): AgentMailTransport => {
  const shared = { credentials: credentials(config), region: config.sesRegion }
  const ses = new SESv2Client(shared)
  const s3 = new S3Client(shared)

  return {
    async createDomainIdentity(domain) {
      const result = await ses.send(
        new CreateEmailIdentityCommand({
          DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
          EmailIdentity: domain,
        }),
      )
      return {
        dkimTokens: result.DkimAttributes?.Tokens ?? [],
        identityArn: undefined,
      }
    },

    async deleteInboundObject(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: config.inboundBucket, Key: key }))
    },

    async getDomainIdentity(domain) {
      try {
        const result = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain }))
        return {
          dkimStatus: result.DkimAttributes?.Status,
          dkimTokens: result.DkimAttributes?.Tokens ?? [],
          verified: result.VerifiedForSendingStatus === true,
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'NotFoundException') return null
        throw error
      }
    },

    async getInboundObject(key) {
      const result = await s3.send(
        new GetObjectCommand({ Bucket: config.inboundBucket, Key: key }),
      )
      return streamToBuffer(result.Body)
    },

    async headInboundObject(key) {
      try {
        const result = await s3.send(
          new HeadObjectCommand({ Bucket: config.inboundBucket, Key: key }),
        )
        return { contentLength: Number(result.ContentLength ?? 0) }
      } catch (error) {
        const name = (error as { name?: string }).name
        if (name === 'NotFound' || name === 'NoSuchKey') return null
        throw error
      }
    },

    async sendRaw(input) {
      const result = await ses.send(
        new SendEmailCommand({
          ConfigurationSetName: config.configurationSet,
          Content: { Raw: { Data: Buffer.from(input.rawMessage, 'utf8') } },
          // Blind recipients ride the API destination, never a Bcc header.
          Destination: { ToAddresses: input.destinations },
          FromEmailAddress: input.fromAddress,
        }),
      )
      if (!result.MessageId) {
        // Ambiguous: SES may or may not have accepted. The caller's `sending`
        // claim resolves this to `delivery_unknown` rather than retrying.
        throw new Error('SES accepted the request but returned no MessageId.')
      }
      return { sesMessageId: result.MessageId }
    },
  }
}
