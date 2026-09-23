/**
 * The runtime owns the rule (one writer for every message stamp, including
 * server-authored DeepWater messages); the worker keeps this import path.
 */
export { persistablePrivateConversationSources } from '@nessie/runtime'
