import { z } from 'zod'
import type { ToolResult, ToolUseContext, Tools } from './types.js'

import { repairSmartQuotedArgs } from './argument-repair.js'

export type Tool<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output = unknown,
> = {
  readonly name: string
  readonly inputSchema: z.ZodType<Input>
  readonly description: string
  readonly maxResultSizeChars: number

  call(args: Input, context: ToolUseContext): Promise<ToolResult<Output>>

  isConcurrencySafe(input: Input): boolean
  isReadOnly(input: Input): boolean
  isDestructive?(input: Input): boolean
  isEnabled(): boolean

  userFacingName(input: Partial<Input> | undefined): string
  getActivityDescription?(input: Partial<Input> | undefined): string | null
}

export type AnyTool = Tool<Record<string, unknown>, unknown>

export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => t.name === name)
}

export function parseToolInput<Input extends Record<string, unknown>>(
  tool: Tool<Input, unknown>,
  rawInput: string | Record<string, unknown>,
): { success: true; data: Input } | { success: false; error: string } {
  // If already an object, just validate it
  if (typeof rawInput !== 'string') {
    const parsed = tool.inputSchema.safeParse(rawInput)
    if (parsed.success) {
      return { success: true, data: parsed.data }
    }
    return { success: false, error: parsed.error.message }
  }

  // Try direct parse first
  let parsed = tool.inputSchema.safeParse(JSON.parse(rawInput))
  if (parsed.success) {
    return { success: true, data: parsed.data }
  }

  // Check for smart quotes and attempt repair
  if (/[\u201c\u201d\u2018\u2019]/.test(rawInput)) {
    const repaired = repairSmartQuotedArgs(rawInput, tool.name)
    if (repaired !== null) {
      const reparsed = tool.inputSchema.safeParse(JSON.parse(repaired))
      if (reparsed.success) {
        return { success: true, data: reparsed.data }
      }
    }
  }

  return { success: false, error: parsed.error.message }
}

type MutableToolKeys = 'isConcurrencySafe' | 'isReadOnly' | 'isDestructive' | 'isEnabled' | 'userFacingName'

export type ToolDef<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output = unknown,
> = Omit<Tool<Input, Output>, MutableToolKeys> & Partial<Pick<Tool<Input, Output>, MutableToolKeys>>

export function buildTool<Input extends Record<string, unknown>, Output>(
  def: ToolDef<Input, Output> & { name: string; inputSchema: z.ZodType<Input> }
): Tool<Input, Output> {
  return {
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    isEnabled: () => true,
    userFacingName: () => def.name,
    ...def,
  } as Tool<Input, Output>
}
