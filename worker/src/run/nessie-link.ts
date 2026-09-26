import { buildNessieResourcePath } from '@nessie/schemas'
import type { AgenticToolResult } from './tools.js'

export const runNessieLink = (args: Record<string, unknown>): AgenticToolResult => {
  try {
    if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('name is required.')
    const path = buildNessieResourcePath(args)
    const label = args.name.replace(/[\\[\]]/g, '\\$&').replace(/[\r\n]/g, ' ')
    return { inputSummary: String(args.kind), output: `[${label}](${path})`, success: true }
  } catch (error) {
    return {
      inputSummary: String(args.kind ?? ''), success: false, correctable: true,
      output: `${error instanceof Error ? error.message : 'Invalid link arguments.'} `
        + 'Supply kind, id and name using the tool schema, plus its required parent context. '
        + 'For example: {kind:"document",id:pageId,name:title,spaceId:spaceId}.',
    }
  }
}
