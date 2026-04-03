import { z } from 'zod'
import type { ToolResult, ToolUseContext, Tools } from './types.js'

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

export type ToolDef<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output = unknown,
> = Omit<Tool<Input, Output>, 'isConcurrencySafe' | 'isReadOnly' | 'isDestructive' | 'isEnabled' | 'userFacingName'> &
  Partial<Pick<Tool<Input, Output>, 'isConcurrencySafe' | 'isReadOnly' | 'isDestructive' | 'isEnabled' | 'userFacingName'>>

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
