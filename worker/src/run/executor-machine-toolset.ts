import type { ToolSchemaDescriptor } from '@nessie/runtime'
import { isCodingSessionToolName } from './coding-session-tools.js'
import type { ExecutorToolset } from './executor-toolset.js'

type Machine = { executorId: string; label: string; toolset: ExecutorToolset }
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Common tool names with an explicit machine selector. Dispatch retains each
 * machine's own schema, catalog, session state, command ledger and fences.
 */
export const combineExecutorToolsets = (machines: Machine[]): ExecutorToolset => {
  const byName = new Map<string, Array<{ machine: Machine; descriptor: ToolSchemaDescriptor }>>()
  for (const machine of machines) {
    for (const descriptor of machine.toolset.descriptors) {
      const entries = byName.get(descriptor.toolName) ?? []
      entries.push({ machine, descriptor })
      byName.set(descriptor.toolName, entries)
    }
  }
  const descriptors = [...byName.values()].map((entries): ToolSchemaDescriptor => {
    const first = entries[0]!.descriptor
    const properties: Record<string, unknown> = {}
    for (const { descriptor } of entries) {
      for (const [key, value] of Object.entries(record(descriptor.inputSchema.properties))) {
        const previous = record(properties[key])
        const next = record(value)
        properties[key] = Array.isArray(previous.enum) && Array.isArray(next.enum)
          ? { ...next, enum: [...new Set([...previous.enum, ...next.enum])] }
          : value
      }
    }
    return {
      ...first,
      description: entries.map(({ machine, descriptor }) =>
        `Machine ${JSON.stringify(machine.label)} (executorId=${machine.executorId}): ${descriptor.description}`,
      ).join('\n'),
      inputSchema: {
        ...first.inputSchema,
        properties: {
          ...properties,
          executorId: { type: 'string', enum: entries.map(({ machine }) => machine.executorId) },
        },
        required: [...new Set(['executorId', ...(first.inputSchema.required as string[] ?? [])])],
      },
    }
  })
  const calls = new Map<string, ExecutorToolset>()
  const select = (executorId: unknown, callId: string): ExecutorToolset | undefined => {
    const toolset = machines.find((machine) => machine.executorId === executorId)?.toolset
    if (toolset) calls.set(callId, toolset)
    return toolset
  }
  const failure = {
    correctable: true as const, inputSummary: '', success: false,
    output: 'Choose executorId from the machines listed in this tool schema. No machine command was sent.',
  }
  const codingDescriptors = descriptors.filter((descriptor) => isCodingSessionToolName(descriptor.toolName))
  return {
    descriptors,
    handledNames: new Set(descriptors.map((descriptor) => descriptor.toolName)),
    machines: machines.map(({ executorId, label, toolset }) => ({
      executorId, label, toolNames: toolset.handledNames,
    })),
    codingSessions: codingDescriptors.length ? {
      descriptors: codingDescriptors, server: 'coding-sessions',
      execute: async (name, { executorId, ...args }, callId, hooks) => {
        const toolset = select(executorId, callId)
        return toolset?.handledNames.has(name) && toolset.codingSessions
          ? toolset.codingSessions.execute(name, args, callId, hooks) : failure
      },
    } : null,
    dispatch: async (name, { executorId, ...args }, callId) => {
      const toolset = select(executorId, callId)
      return toolset?.handledNames.has(name) ? toolset.dispatch(name, args, callId) : failure
    },
    mcpCatalog: async (server, callId, executorId) => {
      const toolset = select(executorId, callId)
      return toolset ? toolset.mcpCatalog(server, callId) : { failure }
    },
    timeoutErrorFor: (name, callId) => (callId ? calls.get(callId) : machines[0]?.toolset)
      ?.timeoutErrorFor(name, callId) ?? null,
    timeoutMsFor: (name) => {
      const values = machines.flatMap(({ toolset }) => {
        const value = toolset.timeoutMsFor(name)
        return value === undefined ? [] : [value]
      })
      return values.length ? Math.max(...values) : undefined
    },
  }
}
