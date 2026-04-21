// src/tools/index.ts
import { BashTool } from './BashTool.js'
import { FileReadTool } from './FileReadTool.js'
import { FileWriteTool } from './FileWriteTool.js'
import { GlobTool } from './GlobTool.js'
import { GrepTool } from './GrepTool.js'
import { WebSearchTool } from './WebSearchTool.js'
import { WorkflowTool } from '../workflow/tool.js'
import { findToolByName, buildTool } from './Tool.js'
import type { Tool, ToolDef, AnyTool } from './Tool.js'
import type { Tools, ToolUseBlock } from './types.js'

export const allTools: Tools = [
  BashTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  WebSearchTool,
  WorkflowTool,
]

export {
  BashTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  WebSearchTool,
  WorkflowTool,
  findToolByName,
  buildTool,
}

export type { Tool, ToolDef, AnyTool, Tools, ToolUseBlock }
