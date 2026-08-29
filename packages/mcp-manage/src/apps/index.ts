/**
 * MCP App Store — the consumer-facing catalogue read.
 *
 * A store dimension on `McpCatalogEntry`, never a second catalogue. It lives
 * in `@nessie/mcp-manage` because both the API routes and the worker's
 * personal-assistant tools must reach it: `api/src/services/*` is unreachable
 * from the worker.
 *
 * Spec: `docs/plans/2026-08-29-mcp-app-store/ux-design-catalogue.md` and
 * `…/ux-design-detail-and-connect.md`.
 */

export * from './app-agent-access.js'
export * from './app-card-state.js'
export * from './app-connections.js'
export * from './app-health.js'
export * from './app-presenter.js'
export * from './app-search.js'
export * from './app-slug.js'
export * from './app-store-detail.js'
export * from './app-store-list.js'
export * from './app-store-visibility.js'
export * from './app-capabilities.js'
export * from './app-connect.js'
export * from './app-connect-custom.js'
