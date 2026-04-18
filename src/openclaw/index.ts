/**
 * src/openclaw/index.ts — OpenClaw interop layer barrel export.
 *
 * Provides translation between Nessie's local orchestration events/types
 * and OpenClaw-compatible session events, agent configs, and announce payloads.
 */

export { toOpenClawKey, fromOpenClawKey, parentKey, resolveAgentMainSessionKey } from './session-mapper.js'
export type { NessieRef, OpenClawSessionKey } from './session-mapper.js'

export { translateEvent, resetSeq } from './event-translator.js'
export type { OpenClawEvent } from './event-translator.js'

export { toAgentConfig, getAllAgentConfigs } from './role-agent-adapter.js'
export type { OpenClawAgentConfig } from './role-agent-adapter.js'

export { toOpenClawAnnounce } from './announce-converter.js'
export type { NessieAnnounce, OpenClawAnnounce } from './announce-converter.js'
