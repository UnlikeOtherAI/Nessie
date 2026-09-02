import { EMAIL_TOOL_DEFINITIONS } from './builtin-email-tools.js'
import { GOOGLE_TOOL_DEFINITIONS } from './builtin-google-tools.js'
import { MAILBOX_TOOL_DEFINITIONS } from './builtin-mailbox-tools.js'

/**
 * Tool ids whose approval requirement is declared in code, not in policy data.
 *
 * `evaluateToolInvokePolicy` defaults to *allow* when no rule matches, and
 * default seeding writes no rule for sending mail — so a purely data-driven
 * gate is absent in every organisation that never configured one. These ids are
 * the exception, and they are collected from the definitions themselves rather
 * than listed by hand: a family that sets `requiresApproval` joins the set by
 * saying so, which is one fewer place to forget.
 *
 * The set lives in its own module because it spans families. It used to sit in
 * the Google file, and each new mail family made that file's name less true.
 */
export const STRUCTURALLY_APPROVAL_GATED_TOOL_IDS = new Set(
  [
    ...GOOGLE_TOOL_DEFINITIONS,
    ...EMAIL_TOOL_DEFINITIONS,
    ...MAILBOX_TOOL_DEFINITIONS,
  ]
    .filter((tool) => tool.requiresApproval)
    .map((tool) => tool.id),
)
