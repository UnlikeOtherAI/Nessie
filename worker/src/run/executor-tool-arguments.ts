import { coerceToolArgumentsToSchema } from './tool-argument-coercion.js'

/**
 * The input schema a local program advertised for one of its tools, once this
 * run has listed that program's catalog; undefined before then.
 */
export type ExecutorMcpInputSchemaLookup = (
  server: string,
  tool: string,
) => Record<string, unknown> | undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Shape an `executor_mcp_call`'s inner `arguments` to the program's own
 * advertised schema: a top-level string becomes the `number`, `integer` or
 * `boolean` that tool declares when it parses cleanly into one, and nothing
 * else changes. This is the client fitting its call to the server's schema,
 * not validation — the daemon still forwards the result untouched, and the
 * program still refuses what it does not accept.
 */
export const normalizeExecutorMcpCallArguments = (
  args: Record<string, unknown>,
  inputSchemaOf: ExecutorMcpInputSchemaLookup,
): Record<string, unknown> => {
  const { arguments: inner, server, tool } = args
  if (typeof server !== 'string' || typeof tool !== 'string' || !isRecord(inner)) return args
  const inputSchema = inputSchemaOf(server, tool)
  if (!inputSchema) return args
  const shaped = coerceToolArgumentsToSchema(inputSchema, inner, { scalarsOnly: true })
  return shaped === inner ? args : { ...args, arguments: shaped }
}

/**
 * The executor dispatch envelope's argument correction. The top level is
 * corrected against the tool's own model-facing schema — the same rule the
 * builtins get, so an `arguments` object that arrives as a JSON string is
 * parsed and a `"4096"` for an integer becomes 4096 — and an `mcp.call`'s
 * inner arguments are then shaped to the program's advertised schema.
 */
export const shapeExecutorToolArguments = (
  operationKey: string,
  inputSchema: unknown,
  args: Record<string, unknown>,
  inputSchemaOf: ExecutorMcpInputSchemaLookup,
): Record<string, unknown> => {
  const corrected = coerceToolArgumentsToSchema(inputSchema, args)
  return operationKey === 'mcp.call'
    ? normalizeExecutorMcpCallArguments(corrected, inputSchemaOf)
    : corrected
}
