/**
 * MCP App Store — ingestion from the official MCP registry.
 *
 * Phase 2 shipped the catalogue and ingested nothing, so `/apps` held the five
 * first-party connectors. This is what fills it: a bounded, cursor-paged read
 * of `registry.modelcontextprotocol.io` through the IP-pinned `safeFetch`, one
 * pure mapper from an upstream record to a catalogue row, a deterministic
 * categoriser so search finds an app by what it does, and an importer that
 * upserts on the stable `registryName` — or, failing that, on the canonical
 * endpoint an existing row already points at, so one server stays one app —
 * while never overwriting a curator.
 *
 * Spec: `docs/plans/2026-08-29-mcp-app-store/overview.md`.
 */

export * from './registry-auth.js'
export * from './registry-categories.js'
export * from './registry-client.js'
export * from './registry-import.js'
export * from './registry-mapper.js'
export * from './registry-merge.js'
export * from './registry-naming.js'
export * from './registry-schema.js'
