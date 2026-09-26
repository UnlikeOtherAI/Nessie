import type { AgentModelOption } from '@nessie/schemas'
import {
  listSubscriptionAdapters,
  SUBSCRIPTION_PROVIDER_PREFIX,
} from '@nessie/model-subscriptions'

/**
 * The model half of the Agent Designer's generated design catalogue.
 *
 * Two sources, exactly as the model picker composes them
 * (`listAgentModelOptionsForUser`): the deployment's Ledger catalogue, and the
 * plans this person linked under Your settings › Connected accounts › AI plans — a personal
 * model connection, which is not a connector and appears in no connector
 * list. The Designer used to be handed the Ledger catalogue alone, so a person
 * who had just linked Kimi and asked for it was told, truthfully for what the
 * Designer held, that no such connector existed. Split out of
 * `global-agent-catalogue.ts` because that file is at the cap, and because the
 * two sources have different rules the block has to keep apart: a plan is
 * spent by its owner, goes only on an agent they own, and is never a default
 * nobody chose.
 */

const MODEL_SHORTLIST = 20

const bullet = (line: string): string => `- ${line}`

export type GlobalAgentModelCatalogueFacts = {
  /**
   * The models this person may put an agent on — the deployment's catalogue
   * and their own linked plans (`source: 'subscription'`), exactly the list
   * the model picker renders. Null when nothing could be read; never a stale
   * guess.
   */
  models: AgentModelOption[] | null
  /**
   * Set when the deployment's Ledger catalogue could not be read but the
   * person's own plans still could: `models` then holds only those, and the
   * block says which half is missing rather than "this deployment lists no
   * models" — which would be a guess, and a wrong one.
   */
  ledgerCatalogueUnavailable?: boolean
}

/** The `provider + model` parameter, stated with both sources it may come from. */
export const modelPairParameterLine = (): string =>
  'provider + model — an exact pair from the models listed below, sent '
  + 'together: one of the deployment catalogue\'s, or one of this person\'s '
  + `own linked plans, whose provider is written ${SUBSCRIPTION_PROVIDER_PREFIX}<key>. `
  + 'Omit both to run on the organisation\'s default.'

/**
 * A person's own linked plan, written with its two fields named. The
 * deployment list writes `provider/model` because a Ledger service id can
 * never contain a slash; a plan's provider is `subscription/<key>`, so the
 * same shorthand would read as three segments with no way to split them.
 */
const describeOwnPlan = (option: AgentModelOption): string =>
  bullet(
    `provider ${option.provider}, model ${option.model} — ${option.displayName}`
    + (option.accountLabel
      ? ` (account ${option.accountLabel}; modelSubscriptionId ${option.modelSubscriptionId})`
      : ''),
  )

/**
 * Rendered in full, never cut by the deployment shortlist: a person's own
 * handful was the one thing they came to ask for, and it sat past the end of
 * a hundred-entry catalogue.
 */
const ownPlansSection = (plans: AgentModelOption[]): string[] => {
  if (plans.length === 0) {
    const providers = listSubscriptionAdapters()
      .map((adapter) => adapter.displayName)
      .join(', ')
    return [
      'This person has linked no plan of their own. A person links one — '
      + `${providers} — under Your settings › Connected accounts › AI plans (/settings/accounts?tab=ai), `
      + 'and it then appears here for the agents they own. The key or sign-in goes '
      + 'only into that settings form, never into this chat.',
    ]
  }
  return [
    `This person's own linked plans (${plans.length}) — a personal model connection, `
    + 'not a connector. The pair goes only on an agent this person owns, which then '
    + 'runs on their plan instead of the organisation\'s credits: put an agent on one '
    + 'when they ask for it, never as a default nobody chose. Written exactly as listed:',
    ...plans.map(describeOwnPlan),
    ...(plans.some((plan) => plan.accountLabel)
      ? [bullet(
          'Two accounts at one provider are told apart by modelSubscriptionId — '
          + 'pass the one they mean beside the pair.',
        )]
      : []),
  ]
}

export const modelCatalogueSection = (facts: GlobalAgentModelCatalogueFacts): string[] => {
  const { models } = facts
  if (models === null) {
    return [
      'The model catalogue could not be read just now. Leave provider and model '
      + 'unset so the agent runs on the organisation default, and say so.',
    ]
  }
  const deployment = models.filter((option) => option.source !== 'subscription')
  const ownPlans = models.filter((option) => option.source === 'subscription')
  const shown = deployment.slice(0, MODEL_SHORTLIST)
  const deploymentLines = facts.ledgerCatalogueUnavailable
    ? [
        'The deployment\'s model catalogue could not be read just now. Leave '
        + 'provider and model unset so the agent runs on the organisation default '
        + '— or use one of this person\'s own plans below — and say so.',
      ]
    : deployment.length === 0
      ? [
          'This deployment lists no selectable models. Leave provider and model '
          + 'unset; the agent runs on the organisation default.',
        ]
      : [
          `Models available here (${deployment.length}${
            deployment.length > shown.length ? `, first ${shown.length} shown` : ''
          }); provider and model are one exact pair:`,
          ...shown.map((option) =>
            bullet(`${option.provider}/${option.model} — ${option.displayName}`)),
        ]
  return [...deploymentLines, '', ...ownPlansSection(ownPlans)]
}
