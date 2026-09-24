import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { launchBrowser } from '../navigation/lib/browser.mjs'
import { ADMIN_URL, REPO_ROOT } from '../navigation/lib/config.mjs'
import { startAdmin, stopProcess } from '../navigation/lib/servers.mjs'

/**
 * The executor's local-MCP surface: the reviewed policy naming servers, the
 * availability of each named server with the reason when it is not, and
 * Kelpie's last-observed instance inventory with its pairing state.
 *
 * A pure fixture suite — the real detail panel over a stubbed access view —
 * so it needs the admin and nothing behind it. Every state is its own
 * scenario and its own screenshot, because the states are the feature:
 * "not installed" and "installed but nothing answered" send a person to
 * opposite machines, and a stale inventory rendered as current is the one
 * lie this screen must never tell.
 */

const screenshots = resolve(REPO_ROOT, 'e2e/screenshots/executor-local-mcp')

// Each case: the scenario, the texts that must render, and texts that must
// NOT render — the dangerous reading each state has to rule out.
const cases = [
  {
    scenario: 'available',
    must: [
      'Local apps',
      'available',
      'Ondrej’s MacBook Pro',
      'MacBookPro18,2',
      'Ondrej’s iPhone',
      'paired',
      'pair on the device',
      'Open Kelpie on this device to pair it before an agent can use it.',
      'ci-runner-2',
      'last seen',
    ],
    mustNot: ['Install Kelpie', '192.168.1.20:8421', '1512×982'],
  },
  {
    scenario: 'not-installed',
    must: [
      'not installed',
      'Install Kelpie on this machine to use it.',
    ],
    // The pairing affordance by its own words. A bare 'paired' also matches
    // the panel's standing "paired executors run only the reviewed local
    // policy" boundary note, which has nothing to do with a Kelpie device.
    mustNot: ['no browser announced itself', 'pair on the device'],
  },
  {
    scenario: 'launch-failed',
    must: [
      'launch failed',
      'Kelpie could not start. Check it on the machine.',
    ],
    mustNot: ['not installed on this machine'],
  },
  {
    scenario: 'handshake-failed',
    must: [
      'connection failed',
      'Kelpie started but could not connect. Check it on the machine.',
    ],
    mustNot: ['not installed on this machine', 'could not start it'],
  },
  {
    scenario: 'unsupported-platform',
    must: ['unsupported platform', 'Kelpie cannot run on this machine’s platform.'],
    mustNot: ['not installed on this machine'],
  },
  {
    scenario: 'not-probed',
    must: ['not checked', 'Kelpie has not been checked yet.'],
    mustNot: ['not installed on this machine'],
  },
  {
    scenario: 'no-browsers',
    must: [
      'available',
      'No nearby browsers found. Open Kelpie on the device you want to use.',
    ],
    mustNot: ['not installed on this machine', 'has not probed the network'],
  },
  {
    scenario: 'unprobed-inventory',
    must: ['available', 'Nearby Kelpie devices have not been checked yet.'],
    mustNot: ['no browser announced itself'],
  },
  {
    scenario: 'stale',
    must: ['observed', 'last seen'],
    mustMatch: [/observed \d+ d ago/, /last seen \d+ d ago/],
    mustNot: ['just now'],
  },
  {
    scenario: 'never-heard',
    must: [
      'The machine has not reported whether these apps are available yet.',
      'never reported',
      'This app is permitted, but the machine has not reported its status yet.',
    ],
    // The availability pills by their own words. A bare 'available' also
    // matches the executor's scope line ("available only to entitled
    // organization work"), which says nothing about an MCP server.
    mustNot: ['not in the last report', 'Kelpie 0.1.11', 'tools listed'],
  },
  {
    scenario: 'named-unreported',
    must: [
      'not in the last report',
      'This app is permitted, but the machine did not include it in its last update.',
    ],
    mustNot: ['has never reported local MCP status'],
  },
  {
    scenario: 'policy-named',
    must: ['Local apps (1):', 'kelpie'],
    mustNot: ['none named'],
  },
  {
    scenario: 'policy-coding-sessions',
    must: [
      'Local apps (2):',
      'Coding agents on this machine: Claude Code (accept edits, 3 pre-allowed commands, at most $5 a turn) '
        + 'and Codex (sandbox workspace-write, no spending limit per turn) in nessie',
      'Each agent may keep up to 3 sessions open at once for the person it works for.',
      'Given the variables CLAUDE_CONFIG_DIR.',
      'They work as this machine’s user, with its files and logins.',
      'sha256:1a2b3c4d5e6f',
    ],
    // A stated null budget is "no spending limit", never a missing clause or a number.
    mustNot: ['none selected', 'null', 'undefined'],
  },
  {
    scenario: 'policy-none-named',
    must: [
      'Local apps: none selected.',
      'Choose an app on the machine before an agent can use its tools.',
    ],
    mustNot: ['Local apps (0)'],
  },
  {
    // The one prepared change whose stored JSON tells a person nothing: it
    // names an agent and a state and no operation at all, because the set is
    // derived from the reviewed revision when it is applied. So the
    // confirmation has to name the agent and list what it is about to be able
    // to run — and must not list the one operation only a person may issue.
    scenario: 'whole-suite-grant',
    must: [
      'Browse files',
      'Read files',
      'Edit draft copies',
      'Run permitted programs',
      'Review draft changes',
    ],
    mustNot: ['workspace.promote', 'agent_executor_grant'],
  },
]

const admin = await startAdmin()
const browser = await launchBrowser()
try {
  const context = await browser.newContext({ viewport: { height: 1000, width: 900 } })
  const page = await context.newPage()
  await mkdir(screenshots, { recursive: true })
  for (const testCase of cases) {
    await page.goto(`${ADMIN_URL}/e2e/executor-local-mcp/index.html?scenario=${testCase.scenario}`)
    // Readiness is the heading of the section under test, rather than the
    // executor's label: the label renders for every scenario whether or not
    // this panel mounted, so it would go green on a page that failed to
    // render the thing being asserted.
    await page.getByText(
      testCase.scenario.startsWith('policy-') || testCase.scenario === 'whole-suite-grant'
        ? 'Review prepared executor change'
        : 'Local apps',
      { exact: true },
    ).waitFor()
    const text = await page.locator('body').innerText()
    for (const expected of testCase.must) {
      assert.ok(text.includes(expected), `${testCase.scenario}: missing "${expected}"`)
    }
    for (const pattern of testCase.mustMatch ?? []) {
      assert.match(text, pattern, `${testCase.scenario}: missing ${pattern}`)
    }
    for (const forbidden of testCase.mustNot) {
      assert.ok(!text.includes(forbidden), `${testCase.scenario}: should not render "${forbidden}"`)
    }
    const path = resolve(screenshots, `${testCase.scenario}.png`)
    await page.screenshot({ fullPage: true, path })
    console.log(`executor-local-mcp: ${testCase.scenario} -> ${path}`)
  }
  await context.close()
  console.log(`Executor local MCP proofs passed: ${cases.length} scenarios`)
} finally {
  await browser.close()
  await stopProcess(admin)
}
