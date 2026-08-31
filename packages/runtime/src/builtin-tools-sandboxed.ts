import { z } from 'zod'

import type { BuiltinToolDefinition } from './builtin-tools-types.js'

// ─── Slice F: sandbox-enforced filesystem + generic HTTP primitives ─────────
//
// These four tools are the bootstrap primitives for the MCP universal connector
// (`docs/plans/2026-05-16-mcp-universal-connector.md` §2 D2). They live in a
// dedicated file so the legacy `builtin-tools.ts` stays under the 500-line cap
// while still owning the assembled `BUILTIN_TOOL_DEFINITIONS` export.

const HttpFetchAuthSchema = z.object({
  kind: z.enum(['bearer', 'apiKey']),
  headerName: z.string().min(1).optional(),
  valuePrefix: z.string().optional(),
  token: z.string().min(1),
})

const HttpFetchInputSchema = z.object({
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .default('GET'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  maxBytes: z.number().int().positive().optional(),
  auth: HttpFetchAuthSchema.optional(),
})

const HttpFetchOutputSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  bodyText: z.string(),
  truncated: z.boolean(),
  bytesRead: z.number().int().nonnegative(),
})

const FileReadInputSchema = z.object({
  path: z.string().min(1),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  maxBytes: z.number().int().positive().optional(),
})

const FileReadOutputSchema = z.object({
  path: z.string(),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
  bytesRead: z.number().int().nonnegative(),
  truncated: z.boolean(),
})

const FileWriteInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  overwrite: z.boolean().default(false),
  createParents: z.boolean().default(false),
})

const FileWriteOutputSchema = z.object({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  created: z.boolean(),
})

const FileGlobInputSchema = z.object({
  pattern: z.string().min(1),
  cwd: z.string().min(1).optional(),
  limit: z.number().int().positive().max(10_000).optional(),
})

const FileGlobOutputSchema = z.object({
  pattern: z.string(),
  cwd: z.string(),
  matches: z.array(z.string()),
  truncated: z.boolean(),
})

export const HTTP_FETCH_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'http_fetch',
  summary: 'Make a generic HTTP request with headers, body, and auth.',
  label: 'HTTP Fetch',
  description:
    'Generic HTTP request primitive. Supports method, headers, body, per-call ' +
    'timeout, response body cap, and bearer/api-key auth. Distinct from ' +
    'web_fetch which is HTML-content extraction.',
  parameters: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        description: 'HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS).',
      },
      url: { type: 'string', description: 'Absolute URL to request.' },
      headers: { type: 'object', description: 'Optional request headers.' },
      body: {
        description: 'Optional request body. String passes through; object is JSON-encoded.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Request timeout in milliseconds. Default 30000, max 120000.',
      },
      maxBytes: {
        type: 'integer',
        description: 'Maximum response body size in bytes. Default 5242880 (5 MB).',
      },
      auth: {
        type: 'object',
        description: 'Optional auth config: bearer or apiKey.',
      },
    },
    required: ['url'],
  },
  safe: true,
  inputSchema: HttpFetchInputSchema,
  outputSchema: HttpFetchOutputSchema,
}

export const FILE_READ_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'file_read',
  summary: 'Read a file inside the configured sandbox roots.',
  label: 'File Read',
  description:
    'Read a file from the local filesystem. Path must resolve inside one of ' +
    'the tool\'s configured `allowedRoots` (sandbox). Returns content as text ' +
    'or base64.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to read.' },
      encoding: { type: 'string', description: 'utf8 or base64. Default utf8.' },
      maxBytes: {
        type: 'integer',
        description: 'Maximum bytes to read. Default 1 MB.',
      },
    },
    required: ['path'],
  },
  safe: true,
  inputSchema: FileReadInputSchema,
  outputSchema: FileReadOutputSchema,
}

export const FILE_WRITE_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'file_write',
  summary: 'Write a file inside the configured sandbox roots.',
  label: 'File Write',
  description:
    'Write a file inside the sandbox `allowedRoots`. Refuses to overwrite ' +
    'an existing file unless `overwrite: true`. Can create parent directories ' +
    'when `createParents: true`.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Destination path.' },
      content: { type: 'string', description: 'File content.' },
      encoding: {
        type: 'string',
        description: 'utf8 or base64 (interpret `content` accordingly). Default utf8.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Required to overwrite an existing file. Default false.',
      },
      createParents: {
        type: 'boolean',
        description: 'Create missing parent directories. Default false.',
      },
    },
    required: ['path', 'content'],
  },
  safe: false,
  inputSchema: FileWriteInputSchema,
  outputSchema: FileWriteOutputSchema,
}

export const FILE_GLOB_TOOL_DEFINITION: BuiltinToolDefinition = {
  id: 'file_glob',
  summary: 'Find files by glob pattern inside the configured sandbox roots.',
  label: 'File Glob',
  description:
    'Glob the filesystem inside the sandbox `allowedRoots`. Both the `cwd` ' +
    'and every match are checked against the allowed roots; patterns that ' +
    'escape are rejected.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts").' },
      cwd: {
        type: 'string',
        description:
          'Working directory for the glob. Must be inside allowedRoots. ' +
          'Defaults to the first allowed root.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum matches to return. Default 1000, max 10000.',
      },
    },
    required: ['pattern'],
  },
  safe: true,
  inputSchema: FileGlobInputSchema,
  outputSchema: FileGlobOutputSchema,
}

export const SANDBOXED_BUILTIN_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  HTTP_FETCH_TOOL_DEFINITION,
  FILE_READ_TOOL_DEFINITION,
  FILE_WRITE_TOOL_DEFINITION,
  FILE_GLOB_TOOL_DEFINITION,
]
