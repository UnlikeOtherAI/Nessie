// The realtime event catalog is one source of truth split along the transport
// seam the contract itself draws (docs/shared-type-contracts-spec.md §4):
// chat/thread streaming rides SSE, presence and agent activity ride the
// WebSocket, and the two never carry each other's events. This module stays the
// single import surface for both halves.
export * from './realtime-sse.js'
export * from './realtime-ws.js'
