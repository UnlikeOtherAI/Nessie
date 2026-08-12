import type { McpCatalogProtocol } from '@nessie/schemas'

/**
 * Which transports the "Add MCP server" wizard may offer a user.
 *
 * `McpCatalogProtocol` has four members, but a *user-authored* connector can
 * only ever reach the network over two of them, so offering the other two hands
 * the user a dead end the server refuses at a different depth each time:
 *
 * - `stdio` is refused immediately — cloud-side process execution is disabled,
 *   so `createCatalogEntry` throws `TRANSPORT_CONFIG_INVALID`
 *   (`packages/mcp-manage/src/mcp-catalog.ts` → `assertCatalogProtocolSafe`),
 *   and transport safety plus worker dispatch refuse again
 *   (`mcp-security.ts` → `assertMcpTransportSafe`, `worker/src/run/tool-mcp.ts`).
 * - `ws` fails later, which is worse: the catalog accepts it and the install
 *   succeeds, then the first probe or tool call dies because
 *   `transportToConnectionSpec` (`packages/mcp-manage/src/mcp-instance-probe.ts`)
 *   has no `ws` case — `@nessie/mcp-client` implements stdio/http/sse only. The
 *   user gets a connector that looks installed and can never run.
 *
 * Both stay in `McpCatalogProtocol` and every server-side guard stays exactly as
 * it is: first-party/managed rows and imported manifests are typed against the
 * full enum, and the server must keep refusing regardless of what any client
 * sends. This list only stops *this* wizard offering a choice that cannot work.
 */
export type OfferableTransport = Extract<McpCatalogProtocol, 'http' | 'sse'>

export const OFFERABLE_TRANSPORTS: readonly OfferableTransport[] = ['http', 'sse']

export const isOfferableTransport = (
  value: McpCatalogProtocol,
): value is OfferableTransport =>
  OFFERABLE_TRANSPORTS.includes(value as OfferableTransport)

/**
 * The option's label names the decision it drives — which endpoint style the
 * server the user is registering actually speaks — rather than restating the
 * protocol id.
 */
export const describeTransport = (value: OfferableTransport): string =>
  value === 'http'
    ? 'HTTP — one URL, streamable (what most remote MCP servers use)'
    : 'SSE — older split endpoint (GET stream + POST messages)'
