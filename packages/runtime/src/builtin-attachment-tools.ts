import type { BuiltinToolDefinition } from './builtin-tools-types.js'

export const ATTACHMENT_UPLOAD_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'attachment_upload',
  category: 'files',
  summary: 'Upload a team attachment from base64 content.',
  label: 'Upload Attachment',
  description:
    'Store a file as a team attachment. Provide the raw bytes as base64 ' +
    'in contentBase64 along with a filename and MIME type. Returns the new ' +
    'attachment id, which can be linked to a message via send_message ' +
    'attachmentIds.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'File name including extension' },
      mime: { type: 'string', description: 'MIME type, e.g. "text/plain" or "image/png"' },
      contentBase64: { type: 'string', description: 'Base64-encoded file bytes' },
      channelId: {
        type: 'string',
        description: 'Optional channel context the attachment belongs to',
      },
    },
    required: ['filename', 'mime', 'contentBase64'],
  },
  safe: false,
}

export const ATTACHMENT_LIST_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'attachment_list',
  category: 'files',
  summary: 'List accessible message attachments in a thread or channel.',
  label: 'List Attachments',
  description:
    'List attachments linked to messages in a thread or channel you can access. ' +
    'Returns id, filename, mime, and sizeBytes for each.',
  parameters: {
    type: 'object',
    properties: {
      threadId: { type: 'string', description: 'Thread to list attachments from' },
      channelId: { type: 'string', description: 'Channel to list attachments from' },
      limit: { type: 'integer', description: 'Maximum results (default 20)', minimum: 1 },
    },
  },
  safe: true,
}

export const ATTACHMENT_READ_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'attachment_read',
  category: 'files',
  summary: 'Read attachment metadata and small text-file content.',
  label: 'Read Attachment',
  description:
    'Return metadata for an attachment, plus the decoded text content for ' +
    'small text-like files. Binary or oversized files return metadata only.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The attachment id to read' },
    },
    required: ['id'],
  },
  safe: true,
}
