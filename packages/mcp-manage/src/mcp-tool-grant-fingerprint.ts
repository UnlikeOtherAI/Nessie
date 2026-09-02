import { createHash } from 'node:crypto'

/**
 * The descriptor shape a person consents to for one projected MCP tool.
 * `annotations` is the registry's persisted metadata, which carries the
 * security-relevant descriptor annotations available to the worker.
 */
export type McpToolDescriptorFingerprintInput = {
  annotations: unknown
  description: string
  inputSchema: unknown
  name: string
  outputSchema: unknown
}

type ToolGrantFingerprintRow = {
  config: unknown
  state: string
}

const canonicalJson = (value: unknown): string => {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

const stringRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}

/**
 * A descriptor digest is deliberately derived from the persisted registry row,
 * not a provider response. A later probe updates that row, making a previously
 * granted fingerprint fail closed until somebody grants the new descriptor.
 */
export const fingerprintMcpToolDescriptor = (
  input: McpToolDescriptorFingerprintInput,
): string =>
  `sha256:${createHash('sha256').update(canonicalJson({
    annotations: input.annotations,
    description: input.description,
    inputSchema: input.inputSchema,
    name: input.name,
    outputSchema: input.outputSchema,
  })).digest('hex')}`

/** The exact ToolGrant config key reserved for an MCP descriptor consent. */
export const MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY = 'descriptorFingerprint'

/**
 * Only an allowed grant carrying the exact current descriptor fingerprint is
 * usable. Unknown or malformed historic config remains a denial.
 */
export const isCurrentAllowedMcpToolGrant = (
  grant: ToolGrantFingerprintRow,
  descriptorFingerprint: string,
): boolean =>
  grant.state === 'allowed'
  && stringRecord(grant.config)[MCP_TOOL_DESCRIPTOR_FINGERPRINT_KEY]
    === descriptorFingerprint
