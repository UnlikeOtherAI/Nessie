import { EFFECTFUL_TOOL_CATEGORY_IDS } from '@nessie/schemas'

import { STRUCTURALLY_APPROVAL_GATED_TOOL_IDS } from './builtin-approval-gates.js'
import { BUILTIN_TOOL_DEFINITIONS } from './builtin-tools.js'

/**
 * Builtins whose dispatch is claimed in `run_tool_effects` before it runs.
 *
 * Two filters, and both have to pass:
 *
 * 1. **Not `safe`.** `safe` is the definition's own statement that the call
 *    only reads. A read-only tool cannot produce a duplicate, so a row for one
 *    is pure cost — and the read-only tools are the ones called constantly.
 * 2. **Its category is one whose effects leave the agent's own workspace**, or
 *    the tool is structurally approval-gated. `EFFECTFUL_TOOL_CATEGORY_IDS`
 *    (`@nessie/schemas`) carries that judgement and the reasoning for it; the
 *    approval-gate union is what keeps a family that declares
 *    `requiresApproval` inside an excluded category covered anyway. Nothing is
 *    gated by name here: a new tool inherits the decision from the category it
 *    already had to choose.
 *
 * Tools that are not builtins at all — MCP and HTTP connector calls, executor
 * dispatches — are not in this set and must not be: their names are per
 * installation, and the ledger covers them by transport instead (they leave
 * Nessie by construction). See `worker/src/run/execute/tool-effect-ledger.ts`.
 */
export const EFFECTFUL_BUILTIN_TOOL_IDS: ReadonlySet<string> = new Set(
  BUILTIN_TOOL_DEFINITIONS
    .filter((tool) =>
      !tool.safe
      && (
        EFFECTFUL_TOOL_CATEGORY_IDS.has(tool.category)
        || STRUCTURALLY_APPROVAL_GATED_TOOL_IDS.has(tool.id)
      ))
    .map((tool) => tool.id),
)
