import type { BuiltinToolDefinition } from './builtin-tools-types.js'

/**
 * Cloud browser tools.
 *
 * The verbs are deliberately the *same closed grammar* the executor's browser
 * bundle already speaks — navigate / click / type / press / scroll, addressed
 * only by an accessibility node id from a prior observe. One browser
 * vocabulary, two transports; the model never learns which one it is on.
 *
 * These carry their own ids rather than reusing `executor.browser.*` because
 * the *grant* is a different decision: an agent trusted with an isolated
 * sandbox on somebody's laptop has not thereby been trusted with a
 * third-party cloud browser that can hold a persistent logged-in session.
 * `requiresExplicitGrant` keeps them off until an owner says otherwise, so
 * connecting a Browserbase account never silently widens an existing agent.
 */

const NODE_ID_DESCRIPTION =
  'A nodeId from the most recent browser_observe. Selectors, CSS paths and '
  + 'pixel coordinates are not accepted.'

export const BROWSER_OPEN_TOOL_ID = 'browser_open'
export const BROWSER_OBSERVE_TOOL_ID = 'browser_observe'
export const BROWSER_ACT_TOOL_ID = 'browser_act'
export const BROWSER_CLOSE_TOOL_ID = 'browser_close'
export const BROWSER_LOGIN_REQUEST_TOOL_ID = 'browser_login_request'
export const BROWSER_DOWNLOAD_TOOL_ID = 'browser_download'

export const CLOUD_BROWSER_TOOL_IDS = [
  BROWSER_OPEN_TOOL_ID,
  BROWSER_OBSERVE_TOOL_ID,
  BROWSER_ACT_TOOL_ID,
  BROWSER_CLOSE_TOOL_ID,
  BROWSER_LOGIN_REQUEST_TOOL_ID,
  BROWSER_DOWNLOAD_TOOL_ID,
] as const

export const BROWSER_TOOL_DEFINITIONS: BuiltinToolDefinition[] = [
  {
    id: BROWSER_OPEN_TOOL_ID,
    category: 'browser',
    label: 'Open Browser',
    summary: 'Open a cloud browser and load a page.',
    description:
      'Open a real Chrome browser in the cloud and navigate to an HTTPS URL. '
      + 'Use it when a page needs to be interacted with rather than just read — '
      + 'a site that needs clicking through, a form, an app behind a UI. For '
      + 'simply reading a public page, web_fetch is cheaper and faster. '
      + 'The browser stays open for the rest of this run unless you close it, '
      + 'and browser time is metered, so close it when the task is done.\n\n'
      + 'mode "mine" opens your own browser, which keeps its logins between '
      + 'runs — use it for anything behind a sign-in. mode "ephemeral" opens a '
      + 'throwaway browser with no history, for public pages. Your own browser '
      + 'can only be open in one run at a time.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The HTTPS URL to load.',
        },
        mode: {
          type: 'string',
          enum: ['mine', 'ephemeral'],
          description:
            'Which browser to open. Defaults to "ephemeral"; use "mine" when '
            + 'the page needs a signed-in session.',
        },
      },
      required: ['url'],
    },
    requiresExplicitGrant: true,
    safe: false,
  },
  {
    id: BROWSER_OBSERVE_TOOL_ID,
    category: 'browser',
    label: 'Observe Browser',
    summary: 'Read the current page as a list of actionable elements.',
    description:
      'Return the current page URL, title, and its accessibility tree as a '
      + 'numbered list of elements. The nodeId of each element is what '
      + 'browser_act takes. Call this after every action that changes the '
      + 'page: node ids are not stable across navigations.',
    parameters: {
      type: 'object',
      properties: {
        includeScreenshot: {
          type: 'boolean',
          description:
            'Also capture a screenshot. Only useful on a vision-capable model, '
            + 'and it costs significant context — leave it off unless the '
            + 'layout itself is the question.',
        },
      },
    },
    requiresExplicitGrant: true,
    safe: true,
  },
  {
    id: BROWSER_ACT_TOOL_ID,
    category: 'browser',
    label: 'Act In Browser',
    summary: 'Click, type, press a key, scroll, or navigate.',
    description:
      'Perform one action in the open browser. Elements are addressed only by '
      + 'the nodeId from the most recent browser_observe.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'click', 'type', 'press', 'scroll'],
          description: 'Which action to perform.',
        },
        url: { type: 'string', description: 'navigate: the HTTPS URL to load.' },
        nodeId: {
          type: 'number',
          description: `click, type, and optionally scroll: ${NODE_ID_DESCRIPTION}`,
        },
        text: { type: 'string', description: 'type: the text to insert.' },
        key: {
          type: 'string',
          enum: [
            'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
            'ArrowRight', 'Backspace', 'Delete', 'Home', 'End', 'PageUp',
            'PageDown', 'Space',
          ],
          description: 'press: the key to send.',
        },
        deltaY: {
          type: 'number',
          description: 'scroll: pixels to scroll vertically; negative scrolls up.',
        },
      },
      required: ['action'],
    },
    requiresExplicitGrant: true,
    safe: false,
  },
  {
    id: BROWSER_CLOSE_TOOL_ID,
    category: 'browser',
    label: 'Close Browser',
    summary: 'Close the cloud browser and stop its meter.',
    description:
      'Close the open cloud browser. Browser time is metered, so close it as '
      + 'soon as the task is finished rather than leaving it for the run to '
      + 'clean up.',
    parameters: { type: 'object', properties: {} },
    requiresExplicitGrant: true,
    safe: true,
  },
  {
    id: BROWSER_LOGIN_REQUEST_TOOL_ID,
    category: 'browser',
    label: 'Ask For A Sign-In',
    summary: 'Ask the person to sign your browser into a service.',
    description:
      'Ask the person who started this run to sign your browser into a '
      + 'service. Use it when a page needs credentials: you cannot type them, '
      + 'and you must never ask for a password in chat. This posts a card with '
      + 'a link that opens your browser for them to sign in themselves, and '
      + 'pauses the run until they are done — your current browser is closed '
      + 'first, so nothing is metered while they take their time. Once they '
      + 'finish, the login stays in your browser for future runs too.',
    parameters: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description:
            'The service needing a sign-in, as a person would name it '
            + '("Google", "Linear"). Shown on the card.',
        },
        reason: {
          type: 'string',
          description: 'One sentence on why you need it, shown on the card.',
        },
      },
      required: ['service', 'reason'],
    },
    requiresExplicitGrant: true,
    safe: false,
  },
  {
    id: BROWSER_DOWNLOAD_TOOL_ID,
    category: 'browser',
    label: 'Download From Browser',
    summary: 'Save a file from the open browser into this workspace.',
    description:
      'Download the file a link or image node points at, and save it as an '
      + 'attachment you can send. Address it by the nodeId from the most recent '
      + 'browser_observe, exactly as with click.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'number',
          description: `The link or image to download: ${NODE_ID_DESCRIPTION}`,
        },
      },
      required: ['nodeId'],
    },
    requiresExplicitGrant: true,
    safe: false,
  },
]
