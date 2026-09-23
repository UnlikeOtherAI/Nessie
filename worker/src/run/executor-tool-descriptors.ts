import { executorLogicalToolDefinitions } from '@nessie/executor-manage'
import { EXECUTOR_KELPIE_MCP_SERVER_NAME } from '@nessie/schemas'
import type { ToolSchemaDescriptor } from '@nessie/runtime'

/**
 * The model-facing name of an executor operation. OpenAI-compatible function
 * names allow `[A-Za-z0-9_-]`, and Meta's API refuses a name with more than
 * one dot, so the dotted operation key travels with underscores: `mcp.tools`
 * is offered as `executor_mcp_tools`. Only the wire name changes — the
 * registry id and the audit action strings keep their dotted spelling.
 */
export const executorToolName = (operationKey: string): string =>
  `executor_${operationKey.split('.').join('_')}`

export type ExecutorDescriptorOptions = {
  /**
   * The local programs the run's bound revision names (`mcpServers`, reviewed
   * with the policy). The two `mcp.*` descriptors offer exactly these as the
   * `server` enum; without any, they are not offered at all.
   */
  mcpServers?: readonly string[]
}

// One line for the programs this release knows by name. Any other named
// program is listed by its name alone: the name is all the policy says.
const WELL_KNOWN_MCP_SERVERS: Readonly<Record<string, string>> = {
  [EXECUTOR_KELPIE_MCP_SERVER_NAME]: 'a real browser on that machine',
  'ollama-search': 'web search through the owner\'s Ollama account',
}

const mcpServersDescription = (description: string, mcpServers: readonly string[]): string => [
  description,
  'Programs on this machine:',
  ...mcpServers.map((server) => (
    WELL_KNOWN_MCP_SERVERS[server] ? `- ${server}: ${WELL_KNOWN_MCP_SERVERS[server]}` : `- ${server}`
  )),
].join('\n')

const mcpInputSchema = (operationKey: string, mcpServers: readonly string[]): Record<string, unknown> | null => {
  const server = { enum: [...mcpServers], type: 'string' }
  switch (operationKey) {
    // The catalog arrives as tool *output*, not as schemas in the prompt.
    // That is the whole point of the pair: a server with 145 tools costs
    // two small schemas here, and the model pays for a tool's arguments
    // only in the turn it decides to use it.
    case 'mcp.tools':
      return {
        additionalProperties: false,
        properties: {
          server,
          // The worker walks the program's pages itself and answers from the
          // whole catalog, so there is no cursor to hand back.
          tool: { maxLength: 128, minLength: 1, type: 'string' },
        },
        required: ['server'],
        type: 'object',
      }
    case 'mcp.call':
      return {
        additionalProperties: false,
        properties: {
          // Unconstrained on purpose: the grammar belongs to the named
          // server, and mirroring it here would drift the first time that
          // server ships a field. Call mcp.tools for a tool's real schema.
          arguments: { type: 'object' },
          server,
          tool: { maxLength: 128, minLength: 1, type: 'string' },
        },
        required: ['server', 'tool'],
        type: 'object',
      }
    default:
      return null
  }
}

const inputSchemaFor = (operationKey: string): Record<string, unknown> | null => {
  switch (operationKey) {
    case 'file.list':
      return {
        additionalProperties: false,
        properties: {
          maxEntries: { maximum: 100, minimum: 1, type: 'integer' },
          path: { maxLength: 1_024, type: 'string' },
        },
        type: 'object',
      }
    case 'file.read':
      return {
        additionalProperties: false,
        properties: {
          maxBytes: { maximum: 8_192, minimum: 1, type: 'integer' },
          path: { maxLength: 1_024, minLength: 1, type: 'string' },
        },
        required: ['path'],
        type: 'object',
      }
    case 'file.write':
      return {
        additionalProperties: false,
        properties: {
          content: { maxLength: 65_536, type: 'string' },
          createParents: { type: 'boolean' },
          overwrite: { type: 'boolean' },
          path: { maxLength: 1_024, minLength: 1, type: 'string' },
        },
        required: ['content', 'path'],
        type: 'object',
      }
    case 'browser.open':
      return {
        additionalProperties: false,
        properties: { url: { format: 'uri', maxLength: 4_096, type: 'string' } },
        required: ['url'],
        type: 'object',
      }
    case 'browser.observe':
      return {
        additionalProperties: false,
        properties: { includeScreenshot: { type: 'boolean' } },
        type: 'object',
      }
    case 'browser.act':
      return {
        additionalProperties: false,
        oneOf: [
          {
            additionalProperties: false,
            properties: {
              action: { const: 'navigate', type: 'string' },
              url: { format: 'uri', maxLength: 4_096, type: 'string' },
            },
            required: ['action', 'url'],
            type: 'object',
          },
          {
            additionalProperties: false,
            properties: {
              action: { const: 'click', type: 'string' },
              nodeId: { maximum: 2_147_483_647, minimum: 0, type: 'integer' },
            },
            required: ['action', 'nodeId'],
            type: 'object',
          },
          {
            additionalProperties: false,
            properties: {
              action: { const: 'type', type: 'string' },
              nodeId: { maximum: 2_147_483_647, minimum: 0, type: 'integer' },
              text: { maxLength: 4_096, type: 'string' },
            },
            required: ['action', 'nodeId', 'text'],
            type: 'object',
          },
          {
            additionalProperties: false,
            properties: {
              action: { const: 'press', type: 'string' },
              key: {
                enum: ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Space'],
                type: 'string',
              },
            },
            required: ['action', 'key'],
            type: 'object',
          },
          {
            additionalProperties: false,
            properties: {
              action: { const: 'scroll', type: 'string' },
              deltaY: { maximum: 10_000, minimum: -10_000, not: { const: 0 }, type: 'integer' },
              nodeId: { maximum: 2_147_483_647, minimum: 0, type: 'integer' },
            },
            required: ['action', 'deltaY'],
            type: 'object',
          },
        ],
        type: 'object',
      }
    case 'command.run':
      return {
        additionalProperties: false,
        properties: {
          args: { items: { maxLength: 4_096, type: 'string' }, maxItems: 64, type: 'array' },
          cwd: { maxLength: 1_024, type: 'string' },
          program: {
            maxLength: 256,
            minLength: 1,
            not: { enum: ['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh'] },
            type: 'string',
          },
        },
        required: ['args', 'program'],
        type: 'object',
      }
    case 'coding.launch':
      return {
        additionalProperties: false,
        properties: { prompt: { maxLength: 4_096, minLength: 1, type: 'string' } },
        required: ['prompt'],
        type: 'object',
      }
    case 'coding.observe':
      return { additionalProperties: false, properties: {}, type: 'object' }
    case 'workspace.review':
      return { additionalProperties: false, properties: {}, type: 'object' }
    case 'sandbox.stop':
      return { additionalProperties: false, properties: {}, type: 'object' }
    default:
      // A descriptor alone cannot enable an operation. Add its hardened
      // companion backend and exact model schema before it is reachable.
      return null
  }
}

export const descriptorFor = (
  operationKey: string,
  options: ExecutorDescriptorOptions = {},
): ToolSchemaDescriptor | null => {
  const definition = executorLogicalToolDefinitions().find((tool) => tool.key === operationKey)
  if (!definition) return null
  const mcpServers = options.mcpServers ?? []
  const isMcp = operationKey === 'mcp.tools' || operationKey === 'mcp.call'
  // A local-apps tool with no program to name reaches nothing, so it is not
  // offered rather than offered with an empty enum.
  if (isMcp && mcpServers.length === 0) return null
  const inputSchema = isMcp ? mcpInputSchema(operationKey, mcpServers) : inputSchemaFor(operationKey)
  if (!inputSchema) return null
  return {
    description: isMcp ? mcpServersDescription(definition.description, mcpServers) : definition.description,
    inputSchema,
    toolName: executorToolName(operationKey),
  }
}
