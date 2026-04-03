// src/tools/index.ts
import { BashTool } from './BashTool.js'
import { FileReadTool } from './FileReadTool.js'
import { FileWriteTool } from './FileWriteTool.js'
import { GlobTool } from './GlobTool.js'
import { GrepTool } from './GrepTool.js'
import { WebSearchTool } from './WebSearchTool.js'
import type { Tools } from './Tool.js'

export const allTools: Tools = [
  BashTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  WebSearchTool,
]

export { BashTool, FileReadTool, FileWriteTool, GlobTool, GrepTool, WebSearchTool }
